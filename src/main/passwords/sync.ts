import { isDeepStrictEqual } from 'node:util'
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import {
  VAULT_PART_DS,
  declaredParts,
  isPartChangeAllowed,
  isVaultIncomplete,
  partPayload,
  splitVault,
  vaultPartD,
  vaultPartIndex,
  type VaultLayout
} from '@shared/password-parts'
import {
  PASSWORD_VAULT_CLIENT,
  PASSWORD_VAULT_KIND,
  PASSWORD_VAULT_TAG,
  PASSWORD_VAULT_VERSION,
  MAX_VAULT_PLAINTEXT_BYTES,
  mergeVaults,
  normalizeVault,
  passwordVaultFilter,
  vaultByteLength,
  type PasswordConfig,
  type PasswordRelaySource,
  type PasswordSaveResult,
  type PasswordVault,
  type PasswordVaultStatus
} from '@shared/passwords'
import { discoverWriteRelays } from '../relay/nip65'
import type { CachedVault, PasswordCache } from './cache'
import type {
  PasswordConfigStoreLike,
  PasswordRelayPoolLike,
  ProviderLike
} from './service'
import {
  MAX_EVENT_CONTENT,
  VAULT_ERROR,
  emptyVault,
  hasLocalChanges,
  trimRelay
} from './vault-ops'

const LOCKED = 'Unlock the password manager first'

/** What this device knows about one encrypted part of the vault. */
interface PartState {
  /** The ciphertext saved on disk. */
  cached: CachedVault | null
  /** The newest decrypted copy seen from a relay or saved here. */
  base: PasswordVault | null
  /** So a replacement event is always newer than the one it replaces. */
  lastCreatedAt: number
}

interface PublishOutcome {
  pending: boolean
  error?: string
}

/** The state `status()` and the background-focus throttle read. */
export interface PasswordSyncState {
  pending: boolean
  syncing: boolean
  lastSyncedAt: number | null
}

export interface PasswordSyncContext {
  isUnlocked: () => boolean
  vault: () => PasswordVault | null
  setVault: (vault: PasswordVault) => void
  pubkey: () => string | null
  setError: (error: string | null) => void
  now: () => number
  config: PasswordConfigStoreLike
  relays: PasswordRelayPoolLike
  cache: PasswordCache
  status: () => PasswordVaultStatus
  sendStatus: () => void
  sendContext: () => void
}

/**
 * The relay sync engine: relay resolution, fetch/merge/publish, the local cache
 * watermark and the pending/syncing flags. It owns no vault state itself; the
 * service passes the current vault and pubkey through closures.
 */
export class PasswordSync {
  private parts = new Map<number, PartState>()
  private layout: VaultLayout = new Map()
  private declared = 0
  private lastSyncedAt: number | null = null
  private pending = false
  private syncing = false
  private resolvedRelays: string[] | null = null
  private relaySource: PasswordRelaySource = 'browser'

  constructor(private readonly ctx: PasswordSyncContext) {}

  state(): PasswordSyncState {
    return {
      pending: this.pending,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt
    }
  }

  /** The saved first part. */
  cachedVault(): CachedVault | null {
    return this.parts.get(0)?.cached ?? null
  }

  /** True when a part known to exist has not been fetched or could not be read. */
  incomplete(): boolean {
    return isVaultIncomplete(this.layout, this.declared)
  }

  /** The saved events for every part, or null when any loaded part has none. */
  savedEvents(): Event[] | null {
    const indexes = [...this.layout.keys()].sort((a, b) => a - b)
    const events = indexes.map((index) => this.parts.get(index)?.cached?.event)
    return indexes.length > 0 && events.every((event) => event !== undefined)
      ? (events as Event[])
      : null
  }

  /** Adopt the ciphertext cache for a newly unlocked identity. */
  load(pubkey: string): void {
    this.parts = new Map()
    this.layout = new Map()
    this.declared = 0
    for (const [index, cached] of this.ctx.cache.getParts(pubkey)) {
      this.parts.set(index, { cached, base: null, lastCreatedAt: cached.event.created_at })
    }
    const saved = [...this.parts.values()].map((part) => part.cached!)
    const synced = saved.map((cached) => cached.syncedAt).filter((at): at is number => at !== null)
    this.lastSyncedAt = synced.length > 0 ? Math.min(...synced) : null
    this.pending = saved.some((cached) => cached.pending)
  }

  /** Decrypt the saved parts. Null when nothing is saved on this device. */
  async openCached(provider: ProviderLike): Promise<{ vault: PasswordVault; failed: boolean } | null> {
    if (this.parts.size === 0) return null
    let vault = emptyVault()
    let failed = false
    for (const [index, part] of [...this.parts].sort(([a], [b]) => a - b)) {
      try {
        const read = await this.decryptPart(provider, this.requirePubkey(), part.cached!.event)
        this.register(index, read)
        part.base = read.vault
        vault = mergeVaults(vault, read.vault).vault
      } catch {
        failed = true
      }
    }
    return { vault, failed }
  }

  /** Forget relay resolution after a config or identity change. */
  resetRelays(): void {
    this.resolvedRelays = null
  }

  /** The relays `status()` should show: the resolved set, or the config fallback. */
  relayInfo(config: PasswordConfig): { urls: string[]; source: PasswordRelaySource } {
    if (this.resolvedRelays) return { urls: this.resolvedRelays, source: this.relaySource }
    return this.defaultRelays(config)
  }

  /** The relays sync uses: the same set the vault does, so one setting covers both. */
  relaysFor(pubkey: string): Promise<string[]> {
    return this.resolveRelays(pubkey, false)
  }

  async sync(provider: ProviderLike, refreshRelays: boolean): Promise<void> {
    const pubkey = this.ctx.pubkey()
    if (!this.ctx.isUnlocked() || !pubkey || !this.ctx.vault()) throw new Error(LOCKED)
    this.syncing = true
    this.ctx.sendStatus()
    try {
      const relays = await this.resolveRelays(pubkey, refreshRelays)
      const { events } = await this.fetchRemoteReport(provider, pubkey, relays)

      // Parts the relays hold that differ from what is saved here.
      const changed = new Map<number, { event: Event; vault: PasswordVault }>()
      let next = this.ctx.vault()!
      for (const [index, event] of events) {
        const part = this.parts.get(index)
        if (part?.base && part.cached?.event.id === event.id && !part.cached.pending) continue
        const read = await this.decryptPart(provider, pubkey, event)
        this.register(index, read)
        next = mergeVaults(next, read.vault).vault
        changed.set(index, { event, vault: read.vault })
      }
      this.ctx.setVault(next)

      const failures: string[] = []
      for (const [index, content] of splitVault(next, this.layout)) {
        const part = this.part(index)
        const remote = changed.get(index)
        let needsPublish = part.cached?.pending === true
        if (remote) {
          part.base = remote.vault
          part.lastCreatedAt = Math.max(part.lastCreatedAt, remote.event.created_at)
          needsPublish ||= hasLocalChanges(content, remote.vault)
          if (!needsPublish) this.adopt(pubkey, index, remote.event)
        } else if (events.has(index)) {
          needsPublish ||= !part.base || hasLocalChanges(content, part.base)
        } else {
          // The relays do not have this part: send ours if there is anything in it.
          needsPublish ||= content.entries.length > 0
        }
        if (!needsPublish) continue
        const outcome = await this.publishPart(provider, pubkey, index, content, relays)
        if (outcome.pending) {
          failures.push(outcome.error ?? 'The vault is saved locally but relay sync failed.')
        }
      }

      this.lastSyncedAt = this.ctx.now()
      this.pending = this.anyPending()
      this.ctx.setError(failures[0] ?? null)
      this.ctx.sendStatus()
    } finally {
      this.syncing = false
      this.ctx.sendStatus()
    }
  }

  async commit(
    provider: ProviderLike,
    pubkey: string,
    next: PasswordVault
  ): Promise<PasswordSaveResult> {
    const before = splitVault(this.ctx.vault() ?? emptyVault(), this.layout)
    const after = splitVault(next, this.layout)
    const dirty = [...after].filter(([index, content]) => {
      const part = this.parts.get(index)
      if (part?.cached?.pending) return true
      if (!part?.base) return content.entries.length > 0
      return !isDeepStrictEqual(content.entries, part.base.entries)
    })
    // A vault that was never saved still needs an event, if only an empty one.
    if (this.parts.size === 0 && dirty.length === 0) dirty.push(...after)
    // Checked for every part before any is sent, so a change is not half saved.
    if (dirty.some(([index, content]) => !isPartChangeAllowed(before.get(index) ?? null, content))) {
      throw new Error('The password vault is full. Delete some logins or shorten notes.')
    }

    const relays = await this.resolveRelays(pubkey, false)
    let failure: string | undefined
    for (const [index, content] of dirty) {
      const outcome = await this.publishPart(provider, pubkey, index, content, relays)
      if (outcome.pending) failure ??= outcome.error
    }
    this.ctx.setVault(next)
    const pending = this.anyPending()
    this.pending = pending
    this.lastSyncedAt = this.ctx.now()
    this.ctx.setError(pending ? 'The vault is saved locally but no relay accepted it.' : null)
    this.ctx.sendStatus()
    this.ctx.sendContext()
    return {
      ok: true,
      ...(pending ? { pending: true } : {}),
      ...(pending ? { error: failure } : {}),
      status: this.ctx.status()
    }
  }

  async ensureLatest(provider: ProviderLike, pubkey: string): Promise<void> {
    const relays = await this.resolveRelays(pubkey, false)
    const report = await this.fetchRemoteReport(provider, pubkey, relays).catch(() => null)
    if (!report) return
    for (const [index, event] of report.events) {
      const cached = this.parts.get(index)?.cached
      if (cached && (event.id === cached.event.id || event.created_at < cached.event.created_at)) {
        continue
      }
      const read = await this.decryptPart(provider, pubkey, event)
      this.register(index, read)
      const merged = mergeVaults(this.ctx.vault() ?? emptyVault(), read.vault).vault
      this.ctx.setVault(merged)
      const part = this.part(index)
      part.base = read.vault
      part.lastCreatedAt = Math.max(part.lastCreatedAt, event.created_at)
      const content = splitVault(merged, this.layout).get(index)!
      if (!hasLocalChanges(content, read.vault)) this.adopt(pubkey, index, event)
    }
  }

  /** Read another identity's prior vault without changing the active sync state. */
  async readVault(provider: ProviderLike, pubkey: string): Promise<{ vault: PasswordVault | null; complete: boolean }> {
    const layout: VaultLayout = new Map()
    let declared = 0
    let vault: PasswordVault | null = null
    const absorb = async (index: number, event: Event): Promise<void> => {
      const read = await this.decryptPart(provider, pubkey, event)
      declared = Math.max(declared, read.declared)
      layout.set(index, new Set())
      vault = mergeVaults(vault ?? emptyVault(), read.vault).vault
    }
    for (const [index, cached] of this.ctx.cache.getParts(pubkey)) await absorb(index, cached.event)

    const relays = await this.resolveRelays(pubkey, true)
    if (relays.length === 0) return { vault, complete: false }
    let remote: { events: Map<number, Event>; answered: number }
    try {
      remote = await this.fetchRemoteReport(provider, pubkey, relays)
    } catch {
      return { vault, complete: false }
    }
    for (const [index, event] of remote.events) await absorb(index, event)
    return {
      vault,
      complete: remote.answered >= relays.length && !isVaultIncomplete(layout, declared)
    }
  }

  private part(index: number): PartState {
    let part = this.parts.get(index)
    if (!part) {
      part = { cached: null, base: null, lastCreatedAt: 0 }
      this.parts.set(index, part)
    }
    return part
  }

  /** Note which entries a part holds. Ids are only ever added: absence deletes nothing. */
  private register(index: number, read: { vault: PasswordVault; declared: number }): void {
    const ids = this.layout.get(index) ?? new Set<string>()
    for (const entry of read.vault.entries) ids.add(entry.id)
    this.layout.set(index, ids)
    this.declared = Math.max(this.declared, read.declared)
  }

  /** Save a relay copy that has everything this device has for that part. */
  private adopt(pubkey: string, index: number, event: Event): void {
    const cached = { event, pending: false, syncedAt: this.ctx.now() }
    this.part(index).cached = cached
    this.ctx.cache.setPart(pubkey, index, cached)
  }

  private anyPending(): boolean {
    return [...this.parts.values()].some((part) => part.cached?.pending === true)
  }

  private requirePubkey(): string {
    const pubkey = this.ctx.pubkey()
    if (!pubkey) throw new Error(VAULT_ERROR)
    return pubkey
  }

  private async publishPart(
    provider: ProviderLike,
    pubkey: string,
    index: number,
    content: PasswordVault,
    relays: string[]
  ): Promise<PublishOutcome> {
    if (relays.length === 0) throw new Error('No vault relay is configured')
    const part = this.part(index)
    const count = Math.max(this.declared, ...[...this.parts.keys()].map((known) => known + 1))
    const payload = partPayload(content, count)
    if (vaultByteLength(payload) > MAX_VAULT_PLAINTEXT_BYTES) {
      throw new Error('The password vault is too large to encrypt. Delete some logins.')
    }
    const ciphertext = await provider.nip44Encrypt(pubkey, JSON.stringify(payload))
    const created_at = Math.max(Math.floor(this.ctx.now() / 1000), part.lastCreatedAt + 1)
    const event = await provider.signEvent({
      kind: PASSWORD_VAULT_KIND,
      created_at,
      tags: [
        ['d', vaultPartD(index)],
        ['t', PASSWORD_VAULT_TAG],
        ['client', PASSWORD_VAULT_CLIENT]
      ],
      content: ciphertext
    })
    if (!verifyEvent(event)) throw new Error('The signer returned an invalid vault event')
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    const results = await Promise.allSettled(
      relays.map((url) => this.ctx.relays.publishWithAuth(url, event, onauth))
    )
    const accepted = results.filter((result) => result.status === 'fulfilled').length
    const pending = accepted < relays.length
    part.lastCreatedAt = event.created_at
    part.base = content
    part.cached = { event, pending, syncedAt: this.ctx.now() }
    this.register(index, { vault: content, declared: 0 })
    this.ctx.cache.setPart(pubkey, index, part.cached)
    return {
      pending,
      ...(pending
        ? {
            error:
              accepted === 0
                ? `No relay accepted the vault (${relays.length} tried)`
                : `${relays.length - accepted} of ${relays.length} relays did not accept the vault`
          }
        : {})
    }
  }

  /**
   * The newest event for each part. New vault events replace the previous addressable
   * event, but relays that were offline during a save keep the old copy; the next sync
   * republishes the merged part once those relays are reachable.
   */
  private async fetchRemoteReport(
    provider: ProviderLike,
    pubkey: string,
    relays: string[]
  ): Promise<{ events: Map<number, Event>; answered: number }> {
    if (relays.length === 0) return { events: new Map(), answered: 0 }
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    const filter = passwordVaultFilter(pubkey, VAULT_PART_DS)
    let events: Event[]
    let answered = relays.length
    if (this.ctx.relays.queryAuthReport) {
      const report = await this.ctx.relays.queryAuthReport(relays, filter, onauth)
      // Nothing answered: say so, rather than treating it as a relay with no vault.
      if (report.answered === 0 && report.events.length === 0) {
        throw new Error(`No relay answered (${relays.length} tried)`)
      }
      events = report.events
      answered = report.answered
    } else {
      events = await this.ctx.relays.queryAuth(relays, filter, onauth)
    }
    const newest = new Map<number, Event>()
    for (const event of events.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
    )) {
      const index = vaultPartIndex(event.tags)
      if (
        index !== null &&
        !newest.has(index) &&
        event.kind === PASSWORD_VAULT_KIND &&
        event.pubkey === pubkey &&
        event.content.length <= MAX_EVENT_CONTENT &&
        verifyEvent(event)
      ) {
        newest.set(index, event)
      }
    }
    return { events: new Map([...newest].sort(([a], [b]) => a - b)), answered }
  }

  async decryptEvent(provider: ProviderLike, event: Event): Promise<PasswordVault> {
    return (await this.decryptPart(provider, this.requirePubkey(), event)).vault
  }

  private async decryptPart(
    provider: ProviderLike,
    pubkey: string,
    event: Event
  ): Promise<{ vault: PasswordVault; declared: number }> {
    const plaintext = await provider.nip44Decrypt(pubkey, event.content)
    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext)
    } catch {
      throw new Error('The decrypted vault is not valid JSON')
    }
    const version =
      parsed && typeof parsed === 'object' ? (parsed as { v?: unknown }).v : undefined
    if (version !== PASSWORD_VAULT_VERSION) {
      throw new Error('This vault was created by a newer version of Nostr Navigator')
    }
    return { vault: normalizeVault(parsed), declared: declaredParts(parsed) }
  }

  private signAuth(provider: ProviderLike, template: EventTemplate): Promise<Event> {
    if (template.kind !== 22242) {
      return Promise.reject(new Error('Unexpected AUTH event kind'))
    }
    return this.signAndVerify(provider, template)
  }

  private async signAndVerify(provider: ProviderLike, template: EventTemplate): Promise<Event> {
    const event = await provider.signEvent(template)
    if (!verifyEvent(event)) throw new Error('The signer returned an invalid AUTH event')
    return event
  }

  private async resolveRelays(pubkey: string, force: boolean): Promise<string[]> {
    if (this.resolvedRelays && !force) return this.resolvedRelays
    const config = this.ctx.config.get().passwords
    if (config.vaultRelay) {
      this.resolvedRelays = [trimRelay(config.vaultRelay)]
      this.relaySource = 'dedicated'
      return this.resolvedRelays
    }
    const configured = this.ctx.config.getRelays()
    if (!config.useNip65) {
      this.resolvedRelays = configured
      this.relaySource = 'browser'
      return configured
    }
    let write: string[] = []
    try {
      write = await discoverWriteRelays(this.ctx.relays.query, pubkey, configured)
    } catch {
      write = []
    }
    const urls = [...new Set([...configured, ...write])].slice(0, 12)
    this.resolvedRelays = urls
    this.relaySource = write.length > 0 ? 'browser+nip65' : 'browser'
    return urls
  }

  private defaultRelays(config: PasswordConfig): {
    urls: string[]
    source: PasswordRelaySource
  } {
    if (config.vaultRelay) {
      return { urls: [trimRelay(config.vaultRelay)], source: 'dedicated' }
    }
    return { urls: this.ctx.config.getRelays(), source: 'browser' }
  }
}
