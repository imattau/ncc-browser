/**
 * NIP-46 remote signer provider. Uses Nostrify's `BunkerURI` and `NConnectSigner`,
 * which already handle bunker parsing, request correlation, NIP-44/NIP-04
 * negotiation, timeouts and response validation. The transport itself is ours, so
 * NCC-05 relay pins and onion routing apply (see `bunker-relay.ts`).
 */

import { BunkerURI, NConnectSigner } from '@nostrify/nostrify'
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
import type { IdentityStatus, RelayEntry } from '@shared/types'
import { parseRelayLocator } from '@shared/relays'
import type { BunkerRelay } from './bunker-relay'
import { SignerError, type EventTemplate } from './crypto'

const DEFAULT_TIMEOUT_MS = 60_000

export interface BunkerTarget {
  remotePubkey: string
  relays: string[]
  /** `ncc://` relay entries from the bunker URI that still need resolving. */
  locators?: string[]
  /** Resolved relay entries, including locator metadata for rotation. */
  entries?: RelayEntry[]
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

  let parsedUrl: URL
  try {
    parsedUrl = new URL(value)
  } catch {
    throw new SignerError('That is not a valid bunker:// URL')
  }
  if (parsedUrl.protocol !== 'bunker:') {
    throw new SignerError('That is not a valid bunker:// URL')
  }

  const relays: string[] = []
  const locators: string[] = []
  for (const raw of parsedUrl.searchParams.getAll('relay')) {
    // A signer (or a user editing the URI) may address its relay by NCC identity.
    const locator = parseRelayLocator(raw)
    if (locator) {
      if (!locators.includes(locator.uri)) locators.push(locator.uri)
      continue
    }

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

  if (relays.length === 0 && locators.length === 0) {
    throw new SignerError('The bunker URL does not list a relay')
  }

  // Validate the remote pubkey with Nostrify's parser. It insists on at least one
  // ws(s) relay, so hand it a placeholder when every relay is an NCC locator.
  const probe = new URL(value)
  const secret = probe.searchParams.get('secret') ?? undefined
  probe.search = ''
  if (secret) probe.searchParams.set('secret', secret)
  probe.searchParams.set('relay', 'wss://placeholder.invalid')
  let uri: BunkerURI
  try {
    uri = new BunkerURI(probe.toString())
  } catch {
    throw new SignerError('That is not a valid bunker:// URL')
  }

  const remotePubkey = uri.pubkey.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(remotePubkey)) {
    throw new SignerError('The bunker URL is missing the remote signer pubkey')
  }

  return {
    remotePubkey,
    relays,
    ...(locators.length > 0 ? { locators } : {}),
    secret: uri.secret
  }
}

export interface RemoteProviderOptions {
  target: BunkerTarget
  clientSecret: Uint8Array
  timeoutMs?: number
  persisted?: boolean
  encryptionAvailable?: boolean
  /** Pinned transport over the app's relay pool; required unless `createSigner` is set. */
  relay?: BunkerRelay
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
      return
    }

    if (!options.relay) {
      throw new SignerError('No NIP-46 relay transport is configured')
    }

    this.signer = new NConnectSigner({
      relay: options.relay as never,
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
    await this.signer.close?.()
  }

  /** Persisted relay entries, including NCC-05 locator metadata. */
  relayEntries(): RelayEntry[] {
    if (this.target.entries) return this.target.entries.map((entry) => ({ ...entry }))
    return this.target.relays.map((url) => ({ url }))
  }

  /**
   * Replace the relay list after a locator rotates. The signer reads the URL list on
   * every request, so no rebuild is needed.
   */
  setRelayEntries(entries: RelayEntry[]): void {
    this.target.entries = entries.map((entry) => ({ ...entry }))
    this.target.relays = [...new Set(entries.map((entry) => entry.url))]
    this.target.locators = []
  }

  /** A copy of the target suitable for persisting to the session file. */
  sessionTarget(): BunkerTarget {
    return {
      remotePubkey: this.target.remotePubkey,
      relays: [...this.target.relays],
      entries: this.relayEntries(),
      ...(this.target.secret ? { secret: this.target.secret } : {})
    }
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
