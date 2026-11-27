import { verifyEvent, type Event, type EventTemplate, nip19 } from 'nostr-tools'
import {
  BOOKMARKS_D,
  SYNC_CLIENT,
  SYNC_KIND,
  SYNC_TAG,
  SYNC_VERSION,
  DEVICE_STALE_MS,
  docKind,
  emptyHistory,
  historyD,
  historyWeeks,
  historyWindowStart,
  IDENTITIES_D,
  mergeIdentityMarks,
  mergeIdentityVaults,
  normalizeIdentityVault,
  planIdentitySync,
  sameIdentityVault,
  type IdentityMark,
  type IdentityVaultDoc,
  mergeBookmarks,
  mergeHistory,
  normalizeBookmarks,
  normalizeHistory,
  normalizeTabs,
  syncFilter,
  tabsD,
  weekOf,
  type SyncTab,
  type TabsDoc
} from '@shared/sync'
import type { SyncCategory, SyncDevice, SyncPrefsPatch, SyncStatus, IdentityRemovalScope } from '@shared/sync-status'
import type { BookmarkStore } from '../bookmarks'
import type { HistoryStore } from '../history'
import type { PasswordRelayPoolLike, ProviderLike } from '../passwords/service'
import type { SyncPrefsStore } from './prefs'

const MAX_EVENT_CONTENT = 1_000_000
const FOCUS_THROTTLE_MS = 30_000
const CHANGE_DEBOUNCE_MS = 15_000
const POLL_MS = 5 * 60_000

export interface SyncDeps {
  prefs: SyncPrefsStore
  identity: { provider(): ProviderLike | null }
  identityVault?: {
    defaultId(): string | null
    providerFor(id: string): ProviderLike | null
    entries(): Array<{ pubkey: string; nsec: string }>
    importSecret(secret: string): Promise<boolean>
  }
  relays: PasswordRelayPoolLike
  resolveRelays(pubkey: string): Promise<string[]>
  bookmarks: BookmarkStore
  history: HistoryStore
  /** Normal tabs only. */
  tabs(): SyncTab[]
  notify(status: SyncStatus): void
  platform: string
  now?: () => number
}

/**
 * Keeps bookmarks, history and open tabs in step across devices.
 *
 * Every document is a NIP-78 event encrypted to the person's own key; the formats and
 * merge rules are in `src/shared/sync.ts`. A sync is: fetch every document, merge each
 * enabled category into the local stores, and publish only what the relays are missing.
 * There is no queue to lose: what still needs publishing is simply whatever differs
 * from the relays at the next sync.
 */
export class SyncService {
  private readonly now: () => number
  private syncing = false
  private again = false
  private lastSyncedAt: number | null = null
  private error: string | null = null
  private devices: SyncDevice[] = []
  private readonly lastCreated = new Map<string, number>()
  private debounce: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private lastTabsKey = ''
  private identityRevision = 0

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  status(): SyncStatus {
    const prefs = this.deps.prefs.get()
    const identityAvailable = this.deps.identity.provider() !== null || Boolean(
      this.deps.identityVault?.defaultId() && this.deps.identityVault.providerFor(this.deps.identityVault.defaultId()!)
    )
    return {
      identity: identityAvailable,
      categories: { ...prefs.categories },
      deviceId: prefs.deviceId,
      deviceName: prefs.deviceName,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      error: this.error,
      devices: this.devices,
      ...this.identityStatus()
    }
  }

  private identityStatus(): Partial<SyncStatus> {
    const prefs = this.deps.prefs.get()
    const vault = this.deps.identityVault
    if (!vault) return {}
    const from = this.identityMigrationFrom()
    const owner = prefs.identityVaultOwnerId ?? vault.defaultId()
    const held = new Set(prefs.categories.identities ? vault.entries().map((entry) => entry.pubkey) : [])
    const removals = prefs.identityState.marks
      .filter((mark) => mark.removed && held.has(mark.pubkey))
      .map((mark) => ({
        pubkey: mark.pubkey,
        npub: nip19.npubEncode(mark.pubkey),
        kept: (prefs.identityKept[mark.pubkey] ?? -1) >= mark.at
      }))
    return {
      identityRevision: this.identityRevision,
      ...(from ? { identityMigrationFrom: from } : {}),
      ...(from && !vault.providerFor(from) ? { identityOwnerMissing: true } : {}),
      ...(prefs.categories.identities && owner ? { identityOwner: owner } : {}),
      ...(removals.length ? { identityRemovals: removals } : {})
    }
  }

  /**
   * Called just before a saved key is removed from this device. Records the choice
   * first, so that no sync can bring the key straight back. Throws if the key must
   * not be removed yet.
   */
  prepareIdentityRemoval(pubkey: string, scope: IdentityRemovalScope): void {
    const prefs = this.deps.prefs.get()
    const syncing = prefs.categories.identities
    const owner = prefs.identityVaultOwnerId ?? (syncing ? this.deps.identityVault?.defaultId() : undefined)
    if (syncing && owner === pubkey) {
      throw new Error(
        'This identity protects your synced identity list. First turn off identity sync, or make another identity the default and migrate the list in Settings → Sync.'
      )
    }
    if (scope === 'everywhere' && !syncing) {
      throw new Error('Turn on identity sync to stop syncing this identity everywhere.')
    }
    // With sync off there is nothing to protect, and the next default can take over.
    if (!syncing && prefs.identityVaultOwnerId === pubkey) this.deps.prefs.setIdentityVaultOwner(undefined)
    const { excluded, marks } = this.deps.prefs.get().identityState
    this.deps.prefs.setIdentityState({
      excluded: [...new Set([...excluded, pubkey])],
      marks:
        scope === 'everywhere' ? mergeIdentityMarks(marks, [this.newMark(pubkey, true)]) : marks
    })
  }

  /** Sends a removal to the relays, and updates the screens. */
  identityRemoved(): void {
    this.notify()
    if (this.deps.prefs.get().categories.identities) void this.syncNow()
  }

  /** Answer for a key held here that was removed from sync: keep it, or sync it again. */
  async resolveIdentityRemoval(pubkey: string, action: 'keep' | 'restore'): Promise<SyncStatus> {
    const prefs = this.deps.prefs.get()
    const mark = prefs.identityState.marks.find((entry) => entry.pubkey === pubkey)
    if (!mark?.removed) return this.status()
    if (action === 'keep') {
      this.deps.prefs.setIdentityState(prefs.identityState, { ...prefs.identityKept, [pubkey]: mark.at })
      this.notify()
      return this.status()
    }
    this.deps.prefs.setIdentityState({
      excluded: prefs.identityState.excluded.filter((entry) => entry !== pubkey),
      marks: mergeIdentityMarks(prefs.identityState.marks, [this.newMark(pubkey, false)])
    })
    this.notify()
    return this.syncNow()
  }

  /**
   * When the key that protected the list is gone from this device, start again from
   * the current default's list. The old encrypted copy stays on the relays.
   */
  async resetIdentityOwner(): Promise<SyncStatus> {
    const from = this.identityMigrationFrom()
    const next = this.deps.identityVault?.defaultId()
    if (!from || !next || this.deps.identityVault?.providerFor(from)) return this.status()
    this.deps.prefs.setIdentityVaultOwner(next)
    this.notify()
    return this.syncNow()
  }

  /** A new choice is always later than the one it replaces, whatever the clocks say. */
  private newMark(pubkey: string, removed: boolean): IdentityMark {
    const previous = this.deps.prefs.get().identityState.marks.find((mark) => mark.pubkey === pubkey)
    return { pubkey, removed, at: Math.max(this.now(), (previous?.at ?? 0) + 1) }
  }

  start(): void {
    if (this.poll) return
    this.deps.bookmarks.onChange = () => this.localChange('bookmarks')
    this.deps.history.onChange = () => this.localChange('history')
    this.poll = setInterval(() => void this.syncNow(), POLL_MS)
    this.poll.unref?.()
    const first = setTimeout(() => void this.syncNow(), 5_000)
    first.unref?.()
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll)
    if (this.debounce) clearTimeout(this.debounce)
    this.poll = null
    this.debounce = null
  }

  /** Called when the open tabs change. */
  tabsChanged(): void {
    this.localChange('tabs')
  }

  onWindowFocus(): void {
    if (this.lastSyncedAt && this.now() - this.lastSyncedAt < FOCUS_THROTTLE_MS) return
    void this.syncNow()
  }

  async configure(patch: SyncPrefsPatch): Promise<SyncStatus> {
    const before = this.deps.prefs.get()
    const wasHistory = before.categories.history
    const next = this.deps.prefs.update(patch)
    const turnedOn =
      (patch.categories?.bookmarks === true && !before.categories.bookmarks) ||
      (patch.categories?.tabs === true && !before.categories.tabs) ||
      (patch.categories?.history === true && !wasHistory)
      || (patch.categories?.identities === true && !before.categories.identities)
    if (patch.categories?.identities === true && !before.categories.identities) {
      const owner = this.deps.identityVault?.defaultId()
      if (owner && !this.deps.prefs.get().identityVaultOwnerId) this.deps.prefs.setIdentityVaultOwner(owner)
    }
    if (patch.deviceName !== undefined) this.lastTabsKey = ''
    this.notify()
    if (turnedOn || patch.deviceName !== undefined) await this.syncNow()
    return this.status()
  }

  async migrateIdentities(): Promise<SyncStatus> {
    const vault = this.deps.identityVault
    const oldId = this.deps.prefs.get().identityVaultOwnerId
    const nextId = vault?.defaultId()
    const oldProvider = oldId ? vault?.providerFor(oldId) : null
    const nextProvider = nextId ? vault?.providerFor(nextId) : null
    if (!vault || !oldId || !nextId || oldId === nextId || !oldProvider || !nextProvider) {
      this.error = 'Both the previous and current default identities must be available to migrate.'
      this.notify()
      return this.status()
    }
    if (this.syncing) {
      this.error = 'Wait for the current sync to finish before migrating the identity vault.'
      this.notify()
      return this.status()
    }
    this.syncing = true
    this.notify()
    try {
      const old = await this.readIdentityVault(oldProvider)
      const current = await this.readIdentityVault(nextProvider)
      // The old list is not read again after this, so it must really have been seen.
      if (!old.complete && !old.found) {
        throw new Error(`${unreadable(old)} The identity vault was left unchanged.`)
      }
      if (!usable(current)) throw new Error(`${unreadable(current)} The identity vault was left unchanged.`)
      const merged = await this.applyIdentityVault(vault, mergeIdentityVaults(old.doc, current.doc, this.now()))
      const pubkey = await nextProvider.getPublicKey()
      const relays = await this.deps.resolveRelays(pubkey)
      if (!relays.length) throw new Error('No relay is configured for identity sync.')
      await this.publish(nextProvider, pubkey, relays, IDENTITIES_D, { ...merged, updatedAt: this.now() })
      this.deps.prefs.setIdentityVaultOwner(nextId)
      this.error = null
    } catch (error) {
      this.error = messageOf(error)
    } finally {
      this.syncing = false
    }
    this.notify()
    return this.status()
  }

  private identityMigrationFrom(): string | null {
    if (!this.deps.prefs.get().categories.identities) return null
    const owner = this.deps.prefs.get().identityVaultOwnerId
    const current = this.deps.identityVault?.defaultId()
    return owner && current && owner !== current ? owner : null
  }

  private async syncIdentityVault(): Promise<void> {
    const vault = this.deps.identityVault
    if (!vault || this.identityMigrationFrom()) return
    const owner = vault.defaultId()
    const provider = owner ? vault.providerFor(owner) : null
    if (!owner || !provider) throw new Error('Identity sync needs an available default identity.')
    const remote = await this.readIdentityVault(provider)
    if (!usable(remote)) throw new Error(`${unreadable(remote)} Sync will try again.`)
    const merged = await this.applyIdentityVault(vault, remote.doc)
    const pubkey = await provider.getPublicKey()
    const relays = await this.deps.resolveRelays(pubkey)
    if (!relays.length) throw new Error('No relay is configured for identity sync.')
    // With some relays silent and no copy seen, a list holding only the key that
    // protects it adds nothing, and could replace a fuller one that was missed.
    const nothingToAdd =
      !remote.found && !remote.complete && !merged.marks?.length && merged.entries.every((entry) => entry.pubkey === pubkey)
    // Compared with the newest copy: anything only an older one still had is sent again.
    if (!nothingToAdd && !sameIdentityVault(merged, remote.newest)) {
      await this.publish(provider, pubkey, relays, IDENTITIES_D, { ...merged, updatedAt: this.now() })
    }
    if (!this.deps.prefs.get().identityVaultOwnerId) this.deps.prefs.setIdentityVaultOwner(owner)
  }

  /** Save what the vault adds to this device, and return what it should now contain. */
  private async applyIdentityVault(
    vault: NonNullable<SyncDeps['identityVault']>,
    remote: IdentityVaultDoc
  ): Promise<IdentityVaultDoc> {
    const plan = (): ReturnType<typeof planIdentitySync> =>
      planIdentitySync(vault.entries(), remote, this.deps.prefs.get().identityState, this.now())
    for (const entry of plan().imports) {
      // Asked again for each key: the person may have removed one while this ran.
      if (this.deps.prefs.get().identityState.excluded.includes(entry.pubkey)) continue
      if (await vault.importSecret(entry.nsec)) this.identityRevision += 1
    }
    const done = plan()
    const { excluded, marks } = this.deps.prefs.get().identityState
    this.deps.prefs.setIdentityState({
      excluded: excluded.filter((pubkey) => !done.unexclude.includes(pubkey)),
      marks: mergeIdentityMarks(marks, done.marks)
    })
    return done.doc
  }

  /**
   * Every copy the relays return is merged, not only the newest: a relay that was
   * away may hold keys that a later copy, written without it, does not. Merging only
   * adds keys, and removal marks still apply.
   */
  private async readIdentityVault(provider: ProviderLike): Promise<IdentityVaultRead> {
    const pubkey = await provider.getPublicKey()
    const relays = await this.deps.resolveRelays(pubkey)
    const empty = normalizeIdentityVault(null)
    if (!relays.length) {
      return { doc: empty, newest: empty, found: false, complete: false, answered: 0, asked: 0, unanswered: [] }
    }
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    let events: Event[]
    let reach = { answered: relays.length, asked: relays.length, unanswered: [] as string[] }
    if (this.deps.relays.queryAuthReport) {
      const report = await this.deps.relays.queryAuthReport(relays, syncFilter(pubkey), onauth)
      events = report.events
      reach = {
        answered: report.answered,
        asked: report.asked ?? relays.length,
        unanswered: report.unanswered ?? []
      }
    } else events = await this.deps.relays.queryAuth(relays, syncFilter(pubkey), onauth)

    const copies = events
      .filter((event) => isSyncEvent(event, pubkey) && dTag(event) === IDENTITIES_D)
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    const complete = reach.answered >= reach.asked
    const latest = copies[0]
    if (!latest) return { doc: empty, newest: empty, found: false, complete, ...reach }
    // The next write must be newer than the copy just read, whatever its device's clock said.
    this.lastCreated.set(IDENTITIES_D, Math.max(this.lastCreated.get(IDENTITIES_D) ?? 0, latest.created_at))
    const newest = normalizeIdentityVault(await this.decrypt(provider, pubkey, latest), this.now())
    let doc = newest
    for (const older of copies.slice(1)) {
      try {
        doc = mergeIdentityVaults(doc, await this.decrypt(provider, pubkey, older), this.now())
      } catch {
        // A damaged old copy must not stop sync; the newest one has been read.
      }
    }
    return { doc, newest, found: true, complete, ...reach }
  }

  /** Remove another device from the list: its next publish brings it back. */
  async removeDevice(id: string): Promise<SyncStatus> {
    const prefs = this.deps.prefs.get()
    if (id === prefs.deviceId) return this.status()
    const device = this.devices.find((entry) => entry.id === id)
    const provider = this.deps.identity.provider() ?? (this.deps.identityVault?.defaultId()
      ? this.deps.identityVault.providerFor(this.deps.identityVault.defaultId()!)
      : null)
    if (!device || !provider) return this.status()
    try {
      const pubkey = await provider.getPublicKey()
      const relays = await this.deps.resolveRelays(pubkey)
      const doc: TabsDoc = {
        v: SYNC_VERSION,
        device: { id, name: device.name, platform: device.platform },
        updatedAt: this.now(),
        tabs: [],
        removed: true
      }
      await this.publish(provider, pubkey, relays, tabsD(id), doc)
      this.devices = this.devices.filter((entry) => entry.id !== id)
      this.error = null
    } catch (error) {
      this.error = messageOf(error)
    }
    this.notify()
    return this.status()
  }

  async syncNow(): Promise<SyncStatus> {
    const prefs = this.deps.prefs.get()
    const dataSyncEnabled = prefs.categories.bookmarks || prefs.categories.tabs || prefs.categories.history
    const identitiesEnabled = prefs.categories.identities
    const ownerId = this.deps.identityVault?.defaultId()
    const provider = dataSyncEnabled
      ? this.deps.identity.provider() ?? (ownerId ? this.deps.identityVault?.providerFor(ownerId) ?? null : null)
      : null
    if ((!dataSyncEnabled && !identitiesEnabled) || (dataSyncEnabled && !provider)) {
      this.notify()
      return this.status()
    }
    if (this.syncing) {
      this.again = true
      return this.status()
    }
    this.syncing = true
    this.notify()
    try {
      if (dataSyncEnabled && provider) await this.run(provider)
      if (identitiesEnabled && !this.identityMigrationFrom()) await this.syncIdentityVault()
      this.error = null
      this.lastSyncedAt = this.now()
    } catch (error) {
      this.error = messageOf(error)
    } finally {
      this.syncing = false
    }
    this.notify()
    if (this.again) {
      this.again = false
      this.schedule()
    }
    return this.status()
  }

  private localChange(category: SyncCategory): void {
    if (!this.deps.prefs.get().categories[category]) return
    this.schedule()
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.syncNow()
    }, CHANGE_DEBOUNCE_MS)
    this.debounce.unref?.()
  }

  private notify(): void {
    this.deps.notify(this.status())
  }

  private async run(provider: ProviderLike): Promise<void> {
    const prefs = this.deps.prefs.get()
    const pubkey = await provider.getPublicKey()
    const relays = await this.deps.resolveRelays(pubkey)
    if (relays.length === 0) throw new Error('No relay is configured for sync')
    const now = this.now()
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    let fetched: Event[]
    if (this.deps.relays.queryAuthReport) {
      const report = await this.deps.relays.queryAuthReport(relays, syncFilter(pubkey), onauth)
      // Nothing answered: stop here instead of calling the data up to date, and instead of
      // waiting on every relay again to publish.
      if (report.answered === 0 && report.events.length === 0) {
        throw new Error(`No relay answered (${relays.length} tried)`)
      }
      fetched = report.events
    } else {
      fetched = await this.deps.relays.queryAuth(relays, syncFilter(pubkey), onauth)
    }
    const latest = latestByD(fetched, pubkey)
    for (const [d, event] of latest) {
      this.lastCreated.set(d, Math.max(this.lastCreated.get(d) ?? 0, event.created_at))
    }

    const failures: string[] = []
    const guarded = async (label: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        failures.push(`${label}: ${messageOf(error)}`)
      }
    }

    if (prefs.categories.bookmarks) {
      await guarded('Bookmarks', async () => {
        const remoteEvent = latest.get(BOOKMARKS_D)
        const remote = remoteEvent
          ? normalizeBookmarks(await this.decrypt(provider, pubkey, remoteEvent), now)
          : normalizeBookmarks({}, now)
        const local = normalizeBookmarks(this.deps.bookmarks.syncDoc(), now)
        const merged = mergeBookmarks(local, remote, now)
        this.deps.bookmarks.applySync(merged)
        if (!sameJson({ ...merged, updatedAt: 0 }, { ...remote, updatedAt: 0 })) {
          if (merged.entries.length > 0 || remoteEvent) {
            await this.publish(provider, pubkey, relays, BOOKMARKS_D, { ...merged, updatedAt: now })
          }
        }
      })
    }

    if (prefs.categories.history) {
      await guarded('History', async () => {
        const start = historyWindowStart(now)
        const end = weekOf(now)
        const remoteWeeks = new Map<number, ReturnType<typeof normalizeHistory>>()
        let remoteFlat = emptyHistory(0)
        for (const [d, event] of latest) {
          const kind = docKind(d)
          if (kind?.kind !== 'history' || kind.week < start || kind.week > end) continue
          try {
            const doc = normalizeHistory(await this.decrypt(provider, pubkey, event), kind.week)
            remoteWeeks.set(kind.week, doc)
            remoteFlat = mergeHistory(remoteFlat, doc)
          } catch (error) {
            failures.push(`History week ${kind.week}: ${messageOf(error)}`)
          }
        }
        const localFlat = {
          ...emptyHistory(0),
          clearedBefore: this.deps.history.clearedBefore,
          entries: this.deps.history.syncEntries()
        }
        const merged = mergeHistory(localFlat, remoteFlat)
        this.deps.history.applySync(merged.entries, merged.clearedBefore)
        for (const doc of historyWeeks(merged.entries, merged.clearedBefore, now)) {
          const remote = remoteWeeks.get(doc.week)
          if (remote && sameJson(remote, doc)) continue
          if (!remote && doc.entries.length === 0 && doc.clearedBefore === 0) continue
          await this.publish(provider, pubkey, relays, historyD(doc.week), doc)
        }
      })
    }

    if (prefs.categories.tabs) {
      await guarded('Tabs', async () => {
        const tabs = this.deps.tabs()
        const key = JSON.stringify([prefs.deviceName, tabs.map((tab) => [tab.url, tab.title])])
        const own = latest.get(tabsD(prefs.deviceId))
        if (key !== this.lastTabsKey || !own) {
          const doc: TabsDoc = {
            v: SYNC_VERSION,
            device: { id: prefs.deviceId, name: prefs.deviceName, platform: this.deps.platform },
            updatedAt: now,
            tabs
          }
          const normalized = normalizeTabs(doc)
          if (normalized) {
            await this.publish(provider, pubkey, relays, tabsD(prefs.deviceId), normalized)
            this.lastTabsKey = key
          }
        }
      })
    }

    // Other devices' tabs are shown whenever tab sync is on.
    const devices: SyncDevice[] = []
    if (prefs.categories.tabs) {
      for (const [d, event] of latest) {
        const kind = docKind(d)
        if (kind?.kind !== 'tabs' || kind.deviceId === prefs.deviceId) continue
        try {
          const doc = normalizeTabs(await this.decrypt(provider, pubkey, event))
          if (!doc || doc.removed || now - doc.updatedAt > DEVICE_STALE_MS) continue
          devices.push({
            id: doc.device.id,
            name: doc.device.name || 'Unnamed device',
            platform: doc.device.platform,
            updatedAt: doc.updatedAt,
            tabs: doc.tabs.map((tab) => ({ url: tab.url, title: tab.title }))
          })
        } catch {
          // A document another version wrote that this one cannot read is just skipped.
        }
      }
      devices.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    this.devices = devices
    if (failures.length > 0) throw new Error(failures.join('; '))
  }

  private async publish(
    provider: ProviderLike,
    pubkey: string,
    relays: string[],
    d: string,
    doc: unknown
  ): Promise<void> {
    const content = await provider.nip44Encrypt(pubkey, JSON.stringify(doc))
    const createdAt = Math.max(Math.floor(this.now() / 1000), (this.lastCreated.get(d) ?? 0) + 1)
    const event = await provider.signEvent({
      kind: SYNC_KIND,
      created_at: createdAt,
      tags: [
        ['d', d],
        ['t', SYNC_TAG],
        ['client', SYNC_CLIENT]
      ],
      content
    })
    if (!verifyEvent(event)) throw new Error('The signer returned an invalid sync event')
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    const results = await Promise.allSettled(
      relays.map((url) => this.deps.relays.publishWithAuth(url, event, onauth))
    )
    const accepted = results.filter((result) => result.status === 'fulfilled').length
    if (accepted === 0) throw new Error(`No relay accepted the update (${relays.length} tried)`)
    this.lastCreated.set(d, createdAt)
  }

  private async decrypt(provider: ProviderLike, pubkey: string, event: Event): Promise<unknown> {
    const plaintext = await provider.nip44Decrypt(pubkey, event.content)
    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext)
    } catch {
      throw new Error('a synced document is not valid JSON')
    }
    const version =
      parsed && typeof parsed === 'object' ? (parsed as { v?: unknown }).v : undefined
    if (version !== SYNC_VERSION) {
      throw new Error('a synced document was written by a newer version')
    }
    return parsed
  }

  private async signAuth(provider: ProviderLike, template: EventTemplate): Promise<Event> {
    if (template.kind !== 22242) throw new Error('Unexpected AUTH event kind')
    const event = await provider.signEvent(template)
    if (!verifyEvent(event)) throw new Error('The signer returned an invalid AUTH event')
    return event
  }
}

interface IdentityVaultRead {
  /** Every copy seen, merged. */
  doc: IdentityVaultDoc
  /** What the newest copy says on its own. */
  newest: IdentityVaultDoc
  found: boolean
  /** Every relay answered. */
  complete: boolean
  answered: number
  asked: number
  unanswered: string[]
}

/**
 * Enough was read to sync. One relay being down must not stop sync for good, so a
 * copy from any relay will do. Without one, at least half have to say there is none.
 */
function usable(read: IdentityVaultRead): boolean {
  return read.found || read.complete || (read.answered > 0 && read.answered * 2 >= read.asked)
}

function unreadable(read: IdentityVaultRead): string {
  if (!read.asked) return 'No relay is configured for identity sync.'
  const silent = read.unanswered.length ? ` (no answer from ${read.unanswered.join(', ')})` : ''
  return `Could not read the identity vault: ${read.answered} of ${read.asked} relays answered and none had a copy${silent}.`
}

function dTag(event: Event): string | undefined {
  return event.tags.find((tag) => tag[0] === 'd')?.[1]
}

function isSyncEvent(event: Event, pubkey: string): boolean {
  if (event.kind !== SYNC_KIND || event.pubkey !== pubkey) return false
  if (event.content.length > MAX_EVENT_CONTENT) return false
  if (!event.tags.some((tag) => tag[0] === 't' && tag[1] === SYNC_TAG)) return false
  return verifyEvent(event)
}

/** Newest valid event for every `d` tag. */
export function latestByD(events: Event[], pubkey: string): Map<string, Event> {
  const latest = new Map<string, Event>()
  for (const event of events) {
    const d = dTag(event)
    if (typeof d !== 'string' || !docKind(d) || !isSyncEvent(event, pubkey)) continue
    const current = latest.get(d)
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      latest.set(d, event)
    }
  }
  return latest
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
