/**
 * One active identity: either a local key or a NIP-46 remote signer. NIP-07 and
 * locator decryption both go through whichever provider is active.
 */

import { generateSecretKey } from 'nostr-tools'
import type { IdentityStatus, RelayEntry } from '@shared/types'
import type { LocatorSigner } from '../ncc/resolver'
import type { BunkerRelay } from './bunker-relay'
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
  relay?: BunkerRelay
}) => RemoteIdentityProvider

export interface IdentityManagerDeps {
  local: IdentityStore
  sessions: Nip46SessionStore
  encryptionAvailable: boolean
  timeoutMs?: number
  remoteFactory?: RemoteFactory
  /** Pinned relay transport for the bunker's relays. */
  bunkerRelay?: (urls: () => string[]) => BunkerRelay
  /** Resolve an `ncc://` relay entry from a bunker URI. */
  resolveRelayLocator?: (input: string) => Promise<RelayEntry | null>
  /** Called whenever the remote signer's relay entries change, e.g. for TLS pins. */
  onRelayEntriesChanged?: (entries: RelayEntry[]) => void
}

const DEFAULT_TIMEOUT_MS = 60_000

export class IdentityManager {
  private readonly localProvider: LocalIdentityProvider
  private readonly factory: RemoteFactory
  private remote: RemoteIdentityProvider | null = null
  private remoteClientSecret: string | null = null
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
        timeoutMs: manager.timeoutMs,
        ...(deps.bunkerRelay ? { relay: deps.bunkerRelay(() => session.target.relays) } : {})
      })
      manager.remoteClientSecret = session.clientSecret
      deps.onRelayEntriesChanged?.(manager.relayEntries())
    }
    return manager
  }

  /** Relay entries used by the active remote signer, for pin registration. */
  relayEntries(): RelayEntry[] {
    return this.remote?.relayEntries() ?? []
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

    if (target.locators?.length) {
      if (!this.deps.resolveRelayLocator) {
        throw new Error('NCC relay resolution is not available')
      }
      const plain = [...target.relays]
      const resolved: RelayEntry[] = []
      for (const locator of target.locators) {
        const entry = await this.deps.resolveRelayLocator(locator)
        if (!entry) {
          throw new Error(`Could not resolve the bunker relay ${locator}`)
        }
        resolved.push(entry)
      }
      // Keep the plain relays in the entry list: rotation and the session file both
      // persist this list, and dropping them would silently lose half the bunker.
      target.entries = [...resolved, ...plain.map((url) => ({ url }))]
      target.relays = [...new Set([...resolved.map((entry) => entry.url), ...plain])]
      target.locators = []
    }

    if (target.relays.length === 0) {
      throw new Error('The bunker has no usable relay')
    }

    // Register pins before connecting: a locator relay may use a self-signed
    // certificate, which only the `k` fingerprint can authorise.
    this.deps.onRelayEntriesChanged?.(target.entries ?? target.relays.map((url) => ({ url })))

    const clientSecret = generateSecretKey()
    const remote = this.factory({
      target,
      clientSecret,
      persisted: false,
      encryptionAvailable: this.deps.encryptionAvailable,
      timeoutMs: this.timeoutMs,
      ...(this.deps.bunkerRelay
        ? { relay: this.deps.bunkerRelay(() => target.relays) }
        : {})
    })

    try {
      await remote.connect()
    } catch (error) {
      await remote.close().catch(() => undefined)
      this.deps.onRelayEntriesChanged?.([])
      throw error
    }

    const previous = this.remote
    this.remote = remote
    this.remoteClientSecret = secretKeyToHex(clientSecret)

    const persisted = await this.deps.sessions.save({
      target,
      clientSecret: this.remoteClientSecret,
      createdAt: Date.now()
    })
    remote.setPersisted(persisted)

    await previous?.close().catch(() => undefined)
    this.deps.onRelayEntriesChanged?.(remote.relayEntries())
    return remote.status()
  }

  /**
   * Re-resolve locator-backed bunker relays. The transport reads the URL list on
   * every request, so updating the provider is enough; the session file is rewritten
   * when an endpoint actually moved.
   */
  async refreshBunkerRelays(
    refresh: (entry: RelayEntry) => Promise<RelayEntry | null>
  ): Promise<RelayEntry[]> {
    const remote = this.remote
    if (!remote || !this.remoteClientSecret) return []

    const entries = remote.relayEntries()
    if (!entries.some((entry) => entry.locator)) return entries

    let changed = false
    const next: RelayEntry[] = []
    for (const entry of entries) {
      if (!entry.locator) {
        next.push(entry)
        continue
      }
      const resolved = await refresh(entry).catch(() => null)
      if (!resolved) {
        next.push({ ...entry, stale: true })
        continue
      }
      if (
        resolved.url !== entry.url ||
        resolved.locator?.k !== entry.locator.k ||
        resolved.locator?.expiresAt !== entry.locator.expiresAt
      ) {
        changed = true
      }
      next.push(resolved)
    }

    remote.setRelayEntries(next)
    this.deps.onRelayEntriesChanged?.(next)
    if (changed) {
      await this.deps.sessions.save({
        target: remote.sessionTarget(),
        clientSecret: this.remoteClientSecret,
        createdAt: Date.now()
      })
    }
    return next
  }

  async disconnectRemote(): Promise<IdentityStatus> {
    const current = this.remote
    this.remote = null
    this.remoteClientSecret = null
    this.deps.onRelayEntriesChanged?.([])
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
    this.remoteClientSecret = null
    this.deps.onRelayEntriesChanged?.([])
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
