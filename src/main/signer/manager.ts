/**
 * One active identity: either a local key or a NIP-46 remote signer. NIP-07 and
 * locator decryption both go through whichever provider is active.
 */

import { generateSecretKey } from 'nostr-tools'
import type { IdentityStatus } from '@shared/types'
import type { LocatorSigner } from '../ncc/resolver'
import { secretKeyToHex } from './crypto'
import type { IdentityStore } from './identity'
import { parseBunker, RemoteIdentityProvider, type BunkerTarget } from './nip46'
import { LocalIdentityProvider, type IdentityProvider } from './provider'
import type { Nip46SessionStore } from './session'

export type RemoteFactory = (args: {
  target: BunkerTarget
  clientSecret: Uint8Array
  persisted: boolean
  encryptionAvailable: boolean
  timeoutMs: number
}) => RemoteIdentityProvider

export interface IdentityManagerDeps {
  local: IdentityStore
  sessions: Nip46SessionStore
  encryptionAvailable: boolean
  timeoutMs?: number
  remoteFactory?: RemoteFactory
}

const DEFAULT_TIMEOUT_MS = 60_000

export class IdentityManager {
  private readonly localProvider: LocalIdentityProvider
  private readonly factory: RemoteFactory
  private remote: RemoteIdentityProvider | null = null
  private readonly timeoutMs: number

  constructor(private readonly deps: IdentityManagerDeps) {
    this.localProvider = new LocalIdentityProvider(deps.local)
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.factory = deps.remoteFactory ?? ((args) => new RemoteIdentityProvider(args))
  }

  /** Loads the local key, if any, and restores a persisted NIP-46 session. */
  static async create(deps: IdentityManagerDeps): Promise<IdentityManager> {
    const manager = new IdentityManager(deps)
    const session = await deps.sessions.load()
    if (session) {
      manager.remote = manager.factory({
        target: session.target,
        clientSecret: hexToBytes(session.clientSecret),
        persisted: true,
        encryptionAvailable: deps.encryptionAvailable,
        timeoutMs: manager.timeoutMs
      })
    }
    return manager
  }

  provider(): IdentityProvider | null {
    if (this.remote) return this.remote
    return this.localProvider.status().configured ? this.localProvider : null
  }

  status(): IdentityStatus {
    return this.remote?.status() ?? this.localProvider.status()
  }

  /** Used by the NCC-05 resolver; remote signers decrypt without exposing a key. */
  locatorSigner(): LocatorSigner | null {
    const provider = this.provider()
    if (!provider) return null
    return {
      getPublicKey: () => provider.getPublicKey(),
      decrypt44: (peer, ciphertext) => provider.decryptLocator(peer, ciphertext)
    }
  }

  async connectRemote(bunkerUrl: string): Promise<IdentityStatus> {
    const target = parseBunker(bunkerUrl)
    const clientSecret = generateSecretKey()
    const remote = this.factory({
      target,
      clientSecret,
      persisted: false,
      encryptionAvailable: this.deps.encryptionAvailable,
      timeoutMs: this.timeoutMs
    })

    try {
      await remote.connect()
    } catch (error) {
      await remote.close().catch(() => undefined)
      throw error
    }

    const previous = this.remote
    this.remote = remote

    const persisted = await this.deps.sessions.save({
      target,
      clientSecret: secretKeyToHex(clientSecret),
      createdAt: Date.now()
    })
    remote.setPersisted(persisted)

    await previous?.close().catch(() => undefined)
    return remote.status()
  }

  async disconnectRemote(): Promise<IdentityStatus> {
    const current = this.remote
    this.remote = null
    this.deps.sessions.clear()
    await current?.close().catch(() => undefined)
    return this.status()
  }

  async importLocal(secret: string): Promise<IdentityStatus> {
    await this.deps.local.import(secret)
    await this.detachRemote()
    return this.status()
  }

  async generateLocal(): Promise<IdentityStatus> {
    await this.deps.local.generate()
    await this.detachRemote()
    return this.status()
  }

  async removeLocal(): Promise<IdentityStatus> {
    this.deps.local.remove()
    return this.status()
  }

  private async detachRemote(): Promise<void> {
    const current = this.remote
    this.remote = null
    this.deps.sessions.clear()
    await current?.close().catch(() => undefined)
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
