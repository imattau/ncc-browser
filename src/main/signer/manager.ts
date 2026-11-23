/** Manages the user's saved Nostr identities and the identity used by NIP-07. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateSecretKey, nip19 } from 'nostr-tools'
import type { IdentityList, IdentityProfile, IdentityStatus, RelayEntry } from '@shared/types'
import type { LocatorSigner } from '../ncc/resolver'
import type { BunkerRelay } from './bunker-relay'
import { hexPubkeyOf, npubOf, nsecOf, parseSecretKey, secretKeyToHex } from './crypto'
import type { IdentityStore } from './identity'
import { parseBunker, RemoteIdentityProvider, type BunkerTarget } from './nip46'
import { EphemeralIdentityProvider, LocalIdentityProvider, type IdentityProvider } from './provider'
import type { Nip46Session, Nip46SessionStore } from './session'

export type RemoteFactory = (args: {
  target: BunkerTarget
  clientSecret: Uint8Array
  persisted: boolean
  encryptionAvailable: boolean
  timeoutMs: number
  relay?: BunkerRelay
}) => RemoteIdentityProvider

type LocalFactory = (id: string) => Promise<IdentityStore>
type SessionFactory = (id: string) => Nip46SessionStore
interface ManagedIdentity {
  id: string
  mode: 'local' | 'nip46'
  local?: IdentityStore
  remote?: RemoteIdentityProvider
  clientSecret?: string
  sessionStore?: Nip46SessionStore
}
interface SavedProfiles { version: 1; ids: string[]; activeId?: string; defaultId?: string }

export interface IdentityManagerDeps {
  local: IdentityStore
  sessions: Nip46SessionStore
  encryptionAvailable: boolean
  timeoutMs?: number
  remoteFactory?: RemoteFactory
  localFactory?: LocalFactory
  sessionFactory?: SessionFactory
  profilesPath?: string
  bunkerRelay?: (urls: () => string[]) => BunkerRelay
  resolveRelayLocator?: (input: string) => Promise<RelayEntry | null>
  onRelayEntriesChanged?: (entries: RelayEntry[]) => void
}

const DEFAULT_TIMEOUT_MS = 60_000

export class IdentityManager {
  private readonly factory: RemoteFactory
  private readonly timeoutMs: number
  private readonly profiles = new Map<string, ManagedIdentity>()
  private activeId: string | null = null
  private defaultId: string | null = null
  /** A session-only identity created for a single service; never persisted. */
  private ephemeral: EphemeralIdentityProvider | null = null

  constructor(private readonly deps: IdentityManagerDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.factory = deps.remoteFactory ?? ((args) => new RemoteIdentityProvider(args))
  }

  static async create(deps: IdentityManagerDeps): Promise<IdentityManager> {
    const manager = new IdentityManager(deps)
    const saved = manager.readProfiles()
    const localStatus = deps.local.status()
    if (localStatus.hexPubkey) {
      manager.profiles.set(localStatus.hexPubkey, { id: localStatus.hexPubkey, mode: 'local', local: deps.local })
    }
    const legacySession = await deps.sessions.load()
    if (legacySession) manager.addRemote(legacySession, deps.sessions)

    // Load profiles recorded in the index. The original identity and bunker files
    // remain readable, so existing installations migrate without rewriting secrets.
    for (const id of saved?.ids ?? []) {
      if (manager.profiles.has(id)) continue
      try {
        const local = await deps.localFactory?.(id)
        if (local?.status().hexPubkey === id) {
          manager.profiles.set(id, { id, mode: 'local', local })
          continue
        }
        const sessionStore = deps.sessionFactory?.(id)
        const session = await sessionStore?.load()
        if (sessionStore && session?.target.remotePubkey === id) manager.addRemote(session, sessionStore)
      } catch (error) {
        console.warn('[identity] could not restore profile:', id, error)
      }
    }

    const valid = (id: string | undefined): string | null => id && manager.profiles.has(id) ? id : null
    const fallback = [...manager.profiles.keys()][0] ?? null
    manager.defaultId = valid(saved?.defaultId) ?? fallback
    manager.activeId = valid(saved?.activeId) ?? manager.defaultId
    manager.sortLegacyRemoteFirstIfNeeded(saved)
    deps.onRelayEntriesChanged?.(manager.relayEntries())
    return manager
  }

  private sortLegacyRemoteFirstIfNeeded(saved: SavedProfiles | null): void {
    if (saved || this.profiles.size < 2) return
    const remote = [...this.profiles.values()].find((item) => item.mode === 'nip46')
    if (remote) { this.defaultId = remote.id; this.activeId = remote.id }
  }

  private readProfiles(): SavedProfiles | null {
    if (!this.deps.profilesPath) return null
    try {
      const value = JSON.parse(readFileSync(this.deps.profilesPath, 'utf8')) as Partial<SavedProfiles>
      if (value.version !== 1 || !Array.isArray(value.ids)) return null
      return { version: 1, ids: value.ids.filter((id): id is string => typeof id === 'string'), activeId: value.activeId, defaultId: value.defaultId }
    } catch { return null }
  }

  private persistProfiles(): void {
    if (!this.deps.profilesPath) return
    try {
      mkdirSync(dirname(this.deps.profilesPath), { recursive: true })
      const tmp = `${this.deps.profilesPath}.tmp`
      const data: SavedProfiles = { version: 1, ids: this.listIds(), activeId: this.activeId ?? undefined, defaultId: this.defaultId ?? undefined }
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.deps.profilesPath)
    } catch (error) { console.warn('[identity] could not save profile preferences:', error) }
  }

  private listIds(): string[] {
    return [...this.profiles.keys()].sort((a, b) => a === this.defaultId ? -1 : b === this.defaultId ? 1 : a.localeCompare(b))
  }

  private addRemote(session: Nip46Session, store: Nip46SessionStore): ManagedIdentity {
    const { target } = session
    const item: ManagedIdentity = {
      id: target.remotePubkey,
      mode: 'nip46',
      remote: this.factory({ target, clientSecret: hexToBytes(session.clientSecret), persisted: true,
        encryptionAvailable: this.deps.encryptionAvailable, timeoutMs: this.timeoutMs,
        ...(this.deps.bunkerRelay ? { relay: this.deps.bunkerRelay(() => target.relays) } : {}) }),
      clientSecret: session.clientSecret,
      sessionStore: store
    }
    this.profiles.set(item.id, item)
    return item
  }

  relayEntries(): RelayEntry[] {
    return this.ephemeral ? [] : (this.active()?.remote?.relayEntries() ?? [])
  }
  provider(): IdentityProvider | null {
    if (this.ephemeral) return this.ephemeral
    const item = this.active()
    if (!item) return null
    return item.remote ?? (item.local ? new LocalIdentityProvider(item.local) : null)
  }
  /** The default identity is the owner of shared browser data such as the password vault. */
  defaultProvider(): IdentityProvider | null {
    const item = this.defaultId ? this.profiles.get(this.defaultId) : null
    if (!item) return null
    return item.remote ?? (item.local ? new LocalIdentityProvider(item.local) : null)
  }
  defaultStatus(): IdentityStatus {
    return this.defaultProvider()?.status() ?? this.deps.local.status()
  }
  /** Identities whose old password vaults may need folding into the default vault. */
  passwordVaultMigrationSources(): Array<{ pubkey: string; provider: IdentityProvider }> {
    return this.listIds()
      .filter((id) => id !== this.defaultId)
      .flatMap((id) => {
        const item = this.profiles.get(id)
        const provider = item?.remote ?? (item?.local ? new LocalIdentityProvider(item.local) : null)
        return provider ? [{ pubkey: id, provider }] : []
      })
  }
  /**
   * Every locally-held identity's secret, for backfilling a "Nostr identity" vault
   * entry — normally only written once, at the moment a key is generated or imported
   * (see ipc-chrome.ts) — for an identity that predates that code or otherwise never
   * got one. Remote (nip46) identities have no local secret to offer.
   */
  localIdentitySecrets(): Array<{ npub: string; nsec: string }> {
    const out: Array<{ npub: string; nsec: string }> = []
    for (const item of this.profiles.values()) {
      if (item.mode !== 'local' || !item.local) continue
      const secret = item.local.getSecret()
      if (!secret) continue
      out.push({ npub: npubOf(secret), nsec: nsecOf(secret) })
    }
    return out
  }
  status(): IdentityStatus { return this.provider()?.status() ?? this.deps.local.status() }

  /** Create a session-only identity for one service; returns its nsec once. */
  generateEphemeral(): { status: IdentityStatus; nsec: string } {
    this.ephemeral?.clear()
    const provider = new EphemeralIdentityProvider()
    this.ephemeral = provider
    return {
      status: provider.status(),
      nsec: nip19.nsecEncode(provider.getSecret())
    }
  }

  /** Promote the session-only identity into the saved identity list. */
  async saveEphemeral(): Promise<IdentityStatus> {
    if (!this.ephemeral) throw new Error('No one-off identity is active')
    const secret = this.ephemeral.getSecret()
    const id = hexPubkeyOf(secret)
    let store = this.profiles.get(id)?.local
    if (!store) store = await this.deps.localFactory?.(id)
    if (!store) {
      if (this.deps.local.status().configured) {
        throw new Error('Multiple local identities are not available')
      }
      store = this.deps.local
    }
    await store.import(secretKeyToHex(secret))
    this.profiles.set(id, { id, mode: 'local', local: store })
    this.activeId = id
    if (!this.defaultId) this.defaultId = id
    this.ephemeral.clear()
    this.ephemeral = null
    this.persistProfiles()
    this.deps.onRelayEntriesChanged?.(this.relayEntries())
    return this.status()
  }

  /** Reveal the session-only nsec again, for the one-off warning panel. */
  ephemeralNsec(): string | null {
    return this.ephemeral ? nip19.nsecEncode(this.ephemeral.getSecret()) : null
  }

  /** Drop the session-only identity and return to the saved active one. */
  clearEphemeral(): IdentityStatus {
    this.ephemeral?.clear()
    this.ephemeral = null
    return this.status()
  }
  activeLocalSecret(): Uint8Array | null { return this.active()?.local?.getSecret() ?? null }

  list(): IdentityList {
    const identities: IdentityProfile[] = this.listIds().map((id) => {
      const item = this.profiles.get(id)!
      const status = item.remote?.status() ?? item.local?.status()
      return { id, mode: item.mode, npub: status?.npub, hexPubkey: id, active: id === this.activeId, isDefault: id === this.defaultId,
        persisted: status?.persisted ?? false, connected: status?.connected }
    })
    return { identities, activeId: this.activeId, defaultId: this.defaultId }
  }

  async select(id: string): Promise<IdentityStatus> {
    this.require(id)
    this.ephemeral?.clear()
    this.ephemeral = null
    this.activeId = id
    this.persistProfiles()
    this.deps.onRelayEntriesChanged?.(this.relayEntries())
    return this.status()
  }
  setDefault(id: string): IdentityList {
    this.require(id); this.defaultId = id; this.persistProfiles(); return this.list()
  }

  locatorSigner(): LocatorSigner | null {
    const provider = this.provider()
    if (!provider) return null
    return { getPublicKey: () => provider.getPublicKey(), decrypt44: (peer, ciphertext) => provider.decryptLocator(peer, ciphertext) }
  }

  async connectRemote(bunkerUrl: string): Promise<IdentityStatus> {
    this.ephemeral?.clear()
    this.ephemeral = null
    const target = parseBunker(bunkerUrl)
    if (target.locators?.length) {
      if (!this.deps.resolveRelayLocator) throw new Error('NCC relay resolution is not available')
      const plain = [...target.relays], resolved: RelayEntry[] = []
      for (const locator of target.locators) {
        const entry = await this.deps.resolveRelayLocator(locator)
        if (!entry) throw new Error(`Could not resolve the bunker relay ${locator}`)
        resolved.push(entry)
      }
      target.entries = [...resolved, ...plain.map((url) => ({ url }))]
      target.relays = [...new Set([...resolved.map((entry) => entry.url), ...plain])]
      target.locators = []
    }
    if (!target.relays.length) throw new Error('The bunker has no usable relay')
    this.deps.onRelayEntriesChanged?.(target.entries ?? target.relays.map((url) => ({ url })))
    const clientSecret = generateSecretKey()
    const remote = this.factory({ target, clientSecret, persisted: false, encryptionAvailable: this.deps.encryptionAvailable,
      timeoutMs: this.timeoutMs, ...(this.deps.bunkerRelay ? { relay: this.deps.bunkerRelay(() => target.relays) } : {}) })
    try { await remote.connect() } catch (error) { await remote.close().catch(() => undefined); this.deps.onRelayEntriesChanged?.([]); throw error }
    const old = this.profiles.get(target.remotePubkey)
    await old?.remote?.close().catch(() => undefined)
    const store = old?.sessionStore ?? this.deps.sessionFactory?.(target.remotePubkey) ?? this.deps.sessions
    const clientHex = secretKeyToHex(clientSecret)
    const persisted = await store.save({ target, clientSecret: clientHex, createdAt: Date.now() })
    remote.setPersisted(persisted)
    this.profiles.set(target.remotePubkey, { id: target.remotePubkey, mode: 'nip46', remote, clientSecret: clientHex, sessionStore: store })
    this.activeId = target.remotePubkey
    if (!this.defaultId) this.defaultId = this.activeId
    this.persistProfiles()
    this.deps.onRelayEntriesChanged?.(this.relayEntries())
    return this.status()
  }

  async refreshBunkerRelays(refresh: (entry: RelayEntry) => Promise<RelayEntry | null>): Promise<RelayEntry[]> {
    const item = this.active()
    const remote = item?.remote
    if (!remote || !item?.clientSecret) return []
    const entries = remote.relayEntries()
    if (!entries.some((entry) => entry.locator)) return entries
    let changed = false
    const next: RelayEntry[] = []
    for (const entry of entries) {
      if (!entry.locator) { next.push(entry); continue }
      const resolved = await refresh(entry).catch(() => null)
      if (!resolved) { next.push({ ...entry, stale: true }); continue }
      if (resolved.url !== entry.url || resolved.locator?.k !== entry.locator?.k || resolved.locator?.expiresAt !== entry.locator?.expiresAt) changed = true
      next.push(resolved)
    }
    remote.setRelayEntries(next); this.deps.onRelayEntriesChanged?.(next)
    if (changed) await item.sessionStore?.save({ target: remote.sessionTarget(), clientSecret: item.clientSecret, createdAt: Date.now() })
    return next
  }

  async importLocal(secret: string): Promise<IdentityStatus> {
    this.ephemeral?.clear()
    this.ephemeral = null
    const parsed = secret.trim()
    const key = parseSecretKey(parsed), id = hexPubkeyOf(key)
    let store = this.profiles.get(id)?.local
    if (!store) store = await this.deps.localFactory?.(id)
    if (!store) {
      if (this.deps.local.status().configured) throw new Error('Multiple local identities are not available')
      store = this.deps.local
    }
    await store.import(parsed)
    this.profiles.set(id, { id, mode: 'local', local: store })
    this.activeId = id; if (!this.defaultId) this.defaultId = id
    this.persistProfiles(); this.deps.onRelayEntriesChanged?.([])
    return this.status()
  }
  async generateLocal(): Promise<IdentityStatus> {
    this.ephemeral?.clear()
    this.ephemeral = null
    const key = generateSecretKey(), id = hexPubkeyOf(key)
    const store = await this.deps.localFactory?.(id) ?? (!this.deps.local.status().configured ? this.deps.local : undefined)
    if (!store) throw new Error('Multiple local identities are not available')
    await store.import(secretKeyToHex(key)); this.profiles.set(id, { id, mode: 'local', local: store })
    this.activeId = id; if (!this.defaultId) this.defaultId = id
    this.persistProfiles(); this.deps.onRelayEntriesChanged?.([]); return this.status()
  }
  async remove(id: string): Promise<IdentityStatus> {
    const item = this.require(id)
    if (item.remote) { await item.remote.close().catch(() => undefined); item.sessionStore?.clear() }
    if (item.local) item.local.remove()
    this.profiles.delete(id)
    if (this.defaultId === id) this.defaultId = this.listIds()[0] ?? null
    if (this.activeId === id) this.activeId = this.defaultId
    this.persistProfiles(); this.deps.onRelayEntriesChanged?.(this.relayEntries())
    return this.status()
  }
  async removeLocal(): Promise<IdentityStatus> {
    const item = this.active()
    if (item?.mode === 'local') return this.remove(item.id)
    return this.status()
  }
  async disconnectRemote(): Promise<IdentityStatus> {
    const item = this.active()
    if (item?.mode === 'nip46') return this.remove(item.id)
    return this.status()
  }

  private active(): ManagedIdentity | null { return this.activeId ? this.profiles.get(this.activeId) ?? null : null }
  private require(id: string): ManagedIdentity { const item = this.profiles.get(id); if (!item) throw new Error('That identity is not available'); return item }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}
