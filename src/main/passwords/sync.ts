import { isDeepStrictEqual } from 'node:util'
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import {
  VAULT_INCOMPLETE,
  VAULT_PART_DS,
  declaredParts,
  isVaultIncomplete,
  partPayload,
  partVault,
  planVault,
  splitVault,
  vaultPartD,
  vaultPartIndex,
  type VaultLayout,
  type VaultPlan
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
  type PasswordEntry,
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

function sameEntries(a: PasswordVault, b: PasswordVault): boolean {
  return isDeepStrictEqual(partVault(a.entries).entries, partVault(b.entries).entries)
}

/** What this device knows about one encrypted part of the vault. */
interface PartState {
  /** The ciphertext saved on disk. */
  cached: CachedVault | null
  /** The newest decrypted copy seen from a relay or saved here. */
  base: PasswordVault | null
  /** So a replacement event is always newer than the one it replaces. */
  lastCreatedAt: number
  /** How many parts `base` says exist. */
  stated: number
}

/** A relay copy of one part, once decrypted. */
interface Absorbed {
  event: Event
  vault: PasswordVault
  /** Older than the copy saved here. */
  stale: boolean
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
      this.parts.set(index, {
        cached,
        base: null,
        lastCreatedAt: cached.event.created_at,
        stated: 0
      })
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
        part.stated = read.declared
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
      const { merged: next, changed } = await this.absorb(provider, pubkey, events, (index, event) => {
        const part = this.parts.get(index)
        return !(part?.base && part.cached?.event.id === event.id && !part.cached.pending)
      })
      this.ctx.setVault(next)

      // Relay copies with everything this device has can be saved as they are.
      const held = splitVault(next, this.layout)
      for (const [index, remote] of changed) {
        const part = this.part(index)
        if (!remote.stale && !part.cached?.pending && !hasLocalChanges(held.get(index)!, remote.vault)) {
          this.adopt(pubkey, index, remote.event)
        }
      }

      const failures = await this.write(
        provider,
        pubkey,
        this.plan(next),
        relays,
        (index, content) => {
          const part = this.part(index)
          if (part.cached?.pending) return true
          const remote = changed.get(index)
          // A relay offering an old copy is brought up to date.
          if (remote?.stale && !sameEntries(content, remote.vault)) return true
          // The relays do not have this part: send ours if there is anything in it.
          if (!events.has(index)) return content.entries.length > 0
          return !part.base || hasLocalChanges(content, part.base)
        }
      )

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
    const plan = this.plan(next)
    // Checked before anything is sent, so a change is not half saved.
    if (plan.full) {
      throw new Error(
        this.incomplete()
          ? `${VAULT_INCOMPLETE}. Sync before adding more.`
          : 'The password vault is full. Delete some logins or shorten notes.'
      )
    }

    const relays = await this.resolveRelays(pubkey, false)
    // A vault that was never saved still needs an event, if only an empty one.
    const unsaved = this.parts.size === 0
    const failures = await this.write(provider, pubkey, plan, relays, (index, content) => {
      const part = this.part(index)
      if (unsaved || part.cached?.pending) return true
      if (!part.base) return content.entries.length > 0
      return !sameEntries(content, part.base)
    })
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
      ...(pending ? { error: failures[0] } : {}),
      status: this.ctx.status()
    }
  }

  async ensureLatest(provider: ProviderLike, pubkey: string): Promise<void> {
    const relays = await this.resolveRelays(pubkey, false)
    const report = await this.fetchRemoteReport(provider, pubkey, relays).catch(() => null)
    if (!report) return
    const { merged, changed } = await this.absorb(provider, pubkey, report.events, (index, event) => {
      const cached = this.parts.get(index)?.cached
      return !cached || (event.id !== cached.event.id && event.created_at >= cached.event.created_at)
    })
    if (changed.size === 0) return
    this.ctx.setVault(merged)
    const held = splitVault(merged, this.layout)
    for (const [index, remote] of changed) {
      if (!hasLocalChanges(held.get(index)!, remote.vault)) this.adopt(pubkey, index, remote.event)
    }
  }

  /**
   * Merge relay copies into the vault and learn which entries each part holds. An entry
   * a newer copy dropped is forgotten there only if another part has it: it moved. An
   * entry no other part has is written back.
   */
  private async absorb(
    provider: ProviderLike,
    pubkey: string,
    events: Map<number, Event>,
    wanted: (index: number, event: Event) => boolean
  ): Promise<{ merged: PasswordVault; changed: Map<number, Absorbed> }> {
    const reads: Array<[number, Event, { vault: PasswordVault; declared: number }]> = []
    for (const [index, event] of events) {
      if (wanted(index, event)) {
        reads.push([index, event, await this.decryptPart(provider, pubkey, event)])
      }
    }
    const changed = new Map<number, Absorbed>()
    const dropped = new Map<number, string[]>()
    let merged = this.ctx.vault() ?? emptyVault()
    for (const [index, event, read] of reads) {
      const part = this.part(index)
      const stale = !!part.cached && event.created_at < part.cached.event.created_at
      if (stale) {
        this.registerStale(index, read)
      } else {
        const ids = new Set(read.vault.entries.map((entry) => entry.id))
        const gone = (part.base?.entries ?? []).map((entry) => entry.id).filter((id) => !ids.has(id))
        if (gone.length > 0) dropped.set(index, gone)
        this.register(index, read)
        part.base = read.vault
        part.stated = read.declared
        part.lastCreatedAt = Math.max(part.lastCreatedAt, event.created_at)
      }
      merged = mergeVaults(merged, read.vault).vault
      changed.set(index, { event, vault: read.vault, stale })
    }
    // After every copy is in, so the destination of a move is already known.
    for (const [index, ids] of dropped) {
      for (const id of ids) {
        const elsewhere = [...this.parts].some(
          ([other, part]) => other !== index && part.base?.entries.some((entry) => entry.id === id)
        )
        if (elsewhere) this.layout.get(index)?.delete(id)
      }
    }
    return { merged, changed }
  }

  private plan(vault: PasswordVault): VaultPlan {
    const saved = new Map<number, PasswordVault>()
    for (const [index, part] of this.parts) if (part.base) saved.set(index, part.base)
    // A missing part could be overwritten by a new one with its number.
    return planVault(vault, this.layout, saved, this.incomplete() ? null : this.partCount())
  }

  private partCount(): number {
    return Math.max(this.declared, ...[...this.layout.keys()].map((index) => index + 1))
  }

  /**
   * Publish the parts that need it. A move is made in order: the destination is saved
   * first, and the source gives the entry up only once every relay has accepted it.
   * Until then the source keeps the copy it had, and a later sync finishes the move.
   */
  private async write(
    provider: ProviderLike,
    pubkey: string,
    plan: VaultPlan,
    relays: string[],
    isDirty: (index: number, content: PasswordVault) => boolean
  ): Promise<string[]> {
    this.layout = plan.layout
    const failures: string[] = []
    // The first part records how many there are, so a reader can tell one is missing.
    const needsCount = (index: number): boolean => {
      const part = this.parts.get(index)
      return index === 0 && !!part?.base && Math.max(part.stated, 1) < this.partCount()
    }
    const send = async (index: number, content: PasswordVault): Promise<void> => {
      const outcome = await this.publishPart(provider, pubkey, index, content, relays)
      if (outcome.pending) {
        failures.push(outcome.error ?? 'The vault is saved locally but relay sync failed.')
      }
    }

    // Highest first: a new part is published before the first part counts it.
    for (const [index, content] of [...plan.parts].sort(([a], [b]) => b - a)) {
      if (plan.leaving.has(index)) continue
      if (isDirty(index, content) || needsCount(index)) await send(index, content)
    }

    for (const [index, leaving] of plan.leaving) {
      const wanted = plan.parts.get(index)!
      const previous = new Map(
        (this.parts.get(index)?.base?.entries ?? []).map((entry) => [entry.id, entry])
      )
      let moved = false
      const entries: PasswordEntry[] = []
      for (const entry of wanted.entries) {
        if (!leaving.has(entry.id)) entries.push(entry)
        else if (this.savedElsewhere(index, entry)) {
          this.layout.get(index)?.delete(entry.id)
          moved = true
        } else entries.push(previous.get(entry.id)!)
      }
      const content = partVault(entries)
      if (moved || isDirty(index, content) || needsCount(index)) await send(index, content)
    }
    return failures
  }

  /** True when another part holds this version and every relay accepted it. */
  private savedElsewhere(source: number, entry: PasswordEntry): boolean {
    return [...this.parts].some(
      ([index, part]) =>
        index !== source &&
        this.layout.get(index)?.has(entry.id) === true &&
        part.cached?.pending !== true &&
        part.base?.entries.some(
          (copy) =>
            copy.id === entry.id &&
            copy.updatedAt >= entry.updatedAt &&
            (copy.favoriteUpdatedAt ?? 0) >= (entry.favoriteUpdatedAt ?? 0)
        ) === true
    )
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
      part = { cached: null, base: null, lastCreatedAt: 0, stated: 0 }
      this.parts.set(index, part)
    }
    return part
  }

  /** An old copy must not give an entry back to a part it has since moved out of. */
  private registerStale(index: number, read: { vault: PasswordVault; declared: number }): void {
    const ids = this.layout.get(index) ?? new Set<string>()
    for (const entry of read.vault.entries) {
      if (![...this.layout.values()].some((held) => held.has(entry.id))) ids.add(entry.id)
    }
    this.layout.set(index, ids)
    this.declared = Math.max(this.declared, read.declared)
  }

  /** Note which entries a part holds. Absence alone deletes nothing. */
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
    const count = this.partCount()
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
    part.stated = count > 1 ? count : 0
    this.register(index, { vault: content, declared: part.stated })
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
