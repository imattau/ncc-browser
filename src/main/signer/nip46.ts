/**
 * NIP-46 remote signer provider. Uses Nostrify's `BunkerURI`, `NConnectSigner` and
 * `NPool`, which already handle bunker parsing, request correlation, NIP-44/NIP-04
 * negotiation, timeouts and response validation.
 */

import { BunkerURI, NConnectSigner, NPool, NRelay1 } from '@nostrify/nostrify'
import type { NostrSigner } from '@nostrify/nostrify'
import {
  finalizeEvent,
  getPublicKey,
  nip04,
  nip44,
  nip19,
  verifyEvent,
  type Event
} from 'nostr-tools'
import type { IdentityStatus } from '@shared/types'
import { SignerError, type EventTemplate } from './crypto'

const DEFAULT_TIMEOUT_MS = 60_000

export interface BunkerTarget {
  remotePubkey: string
  relays: string[]
  secret?: string
}

export interface RemoteSignerLike {
  connect(secret?: string): Promise<string>
  getPublicKey(): Promise<string>
  signEvent(event: EventTemplate): Promise<Event>
  readonly nip04: {
    encrypt(peer: string, plaintext: string): Promise<string>
    decrypt(peer: string, ciphertext: string): Promise<string>
  }
  readonly nip44: {
    encrypt(peer: string, plaintext: string): Promise<string>
    decrypt(peer: string, ciphertext: string): Promise<string>
  }
  close?(): Promise<void>
}

/**
 * Minimal `NostrSigner` for the client side of NIP-46. The remote signer never sees
 * this key; it only authenticates and encrypts the RPC channel.
 */
class LocalNostrSigner {
  constructor(private readonly secret: Uint8Array) {}

  async getPublicKey(): Promise<string> {
    return getPublicKey(this.secret)
  }

  async signEvent(event: { kind: number; created_at: number; tags: string[][]; content: string }) {
    return finalizeEvent(event, this.secret)
  }

  readonly nip04 = {
    encrypt: async (peer: string, plaintext: string): Promise<string> =>
      nip04.encrypt(this.secret, peer, plaintext),
    decrypt: async (peer: string, ciphertext: string): Promise<string> =>
      nip04.decrypt(this.secret, peer, ciphertext)
  }

  readonly nip44 = {
    encrypt: async (peer: string, plaintext: string): Promise<string> =>
      nip44.encrypt(plaintext, nip44.getConversationKey(this.secret, peer)),
    decrypt: async (peer: string, ciphertext: string): Promise<string> =>
      nip44.decrypt(ciphertext, nip44.getConversationKey(this.secret, peer))
  }
}

export function parseBunker(input: string): BunkerTarget {
  const value = input.trim()
  if (!value) throw new SignerError('Paste a bunker:// URL from your signer')

  let uri: BunkerURI
  try {
    uri = new BunkerURI(value)
  } catch {
    throw new SignerError('That is not a valid bunker:// URL')
  }

  const remotePubkey = uri.pubkey.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(remotePubkey)) {
    throw new SignerError('The bunker URL is missing the remote signer pubkey')
  }
  if (uri.relays.length === 0) {
    throw new SignerError('The bunker URL does not list a relay')
  }

  const relays: string[] = []
  for (const raw of uri.relays) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new SignerError(`Not a valid relay URL: ${raw}`)
    }
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
      throw new SignerError(`NIP-46 relays must use ws:// or wss://: ${raw}`)
    }
    const normalized = url.toString().replace(/\/$/, '')
    if (!relays.includes(normalized)) relays.push(normalized)
  }

  return { remotePubkey, relays, secret: uri.secret }
}

export interface RemoteProviderOptions {
  target: BunkerTarget
  clientSecret: Uint8Array
  timeoutMs?: number
  persisted?: boolean
  encryptionAvailable?: boolean
  /** Injectable for tests. */
  createSigner?: (args: {
    target: BunkerTarget
    clientSecret: Uint8Array
    timeoutMs: number
  }) => RemoteSignerLike
}

export class RemoteIdentityProvider {
  private readonly target: BunkerTarget
  private readonly signer: RemoteSignerLike
  private readonly pool: NPool | null
  private readonly timeoutMs: number
  private persisted: boolean
  private readonly encryptionAvailable: boolean

  private connection: Promise<void> | null = null
  private connected = false

  constructor(options: RemoteProviderOptions) {
    this.target = options.target
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.persisted = options.persisted ?? false
    this.encryptionAvailable = options.encryptionAvailable ?? false

    if (options.createSigner) {
      this.signer = options.createSigner({
        target: options.target,
        clientSecret: options.clientSecret,
        timeoutMs: this.timeoutMs
      })
      this.pool = null
      return
    }

    const relays = this.target.relays
    const pool = new NPool({
      open: (url) => new NRelay1(url),
      reqRouter: (filters) => new Map(relays.map((url) => [url, filters])),
      eventRouter: () => relays
    })
    this.pool = pool
    this.signer = new NConnectSigner({
      relay: pool,
      pubkey: this.target.remotePubkey,
      signer: new LocalNostrSigner(options.clientSecret) as unknown as NostrSigner,
      timeout: this.timeoutMs,
      encryption: 'nip44'
    }) as unknown as RemoteSignerLike
  }

  status(): IdentityStatus {
    return {
      configured: true,
      mode: 'nip46',
      npub: nip19.npubEncode(this.target.remotePubkey),
      hexPubkey: this.target.remotePubkey,
      source: this.persisted ? 'file' : 'session',
      persisted: this.persisted,
      encryptionAvailable: this.encryptionAvailable,
      relays: [...this.target.relays],
      connected: this.connected
    }
  }

  setPersisted(persisted: boolean): void {
    this.persisted = persisted
  }

  async connect(): Promise<void> {
    await this.ensureConnected()
  }

  async getPublicKey(): Promise<string> {
    return this.target.remotePubkey
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    await this.ensureConnected()
    const event = await this.signer.signEvent(template)
    if (!verifyEvent(event) || event.pubkey !== this.target.remotePubkey) {
      throw new SignerError('The remote signer returned an invalid or mismatched event')
    }
    return event
  }

  async nip04Encrypt(peer: string, plaintext: string): Promise<string> {
    await this.ensureConnected()
    return this.signer.nip04.encrypt(peer, plaintext)
  }

  async nip04Decrypt(peer: string, ciphertext: string): Promise<string> {
    await this.ensureConnected()
    return this.signer.nip04.decrypt(peer, ciphertext)
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    await this.ensureConnected()
    return this.signer.nip44.encrypt(peer, plaintext)
  }

  async nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    await this.ensureConnected()
    return this.signer.nip44.decrypt(peer, ciphertext)
  }

  async decryptLocator(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.nip44Decrypt(peerPubkey, ciphertext)
  }

  async close(): Promise<void> {
    this.connection = null
    this.connected = false
    if (this.pool) {
      await this.pool.close()
      return
    }
    await this.signer.close?.()
  }

  private ensureConnected(): Promise<void> {
    if (!this.connection) {
      this.connection = this.signer
        .connect(this.target.secret)
        .then(() => {
          this.connected = true
        })
        .catch((error) => {
          this.connection = null
          this.connected = false
          throw error
        })
    }
    return this.connection
  }
}
