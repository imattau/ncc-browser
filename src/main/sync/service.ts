import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
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
  mergeIdentityVaults,
  normalizeIdentityVault,
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
import type { SyncCategory, SyncDevice, SyncPrefsPatch, SyncStatus } from '@shared/sync-status'
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
      ...(this.identityMigrationFrom() ? { identityMigrationFrom: this.identityMigrationFrom()! } : {})
    }
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
      if (!old.complete || !current.complete) throw new Error('Could not read every relay; the identity vault was left unchanged.')
      const merged = mergeIdentityVaults(
        { v: 1, updatedAt: this.now(), entries: vault.entries() },
        mergeIdentityVaults(old.doc, current.doc, this.now()),
        this.now()
      )
      for (const entry of merged.entries) await vault.importSecret(entry.nsec)
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
    if (!remote.complete) throw new Error('Could not read every relay for the identity vault.')
    const merged = mergeIdentityVaults(
      { v: 1, updatedAt: this.now(), entries: vault.entries() },
      remote.doc,
      this.now()
    )
    for (const entry of merged.entries) await vault.importSecret(entry.nsec)
    const pubkey = await provider.getPublicKey()
    const relays = await this.deps.resolveRelays(pubkey)
    if (!relays.length) throw new Error('No relay is configured for identity sync.')
    if (!sameJson(merged, remote.doc)) await this.publish(provider, pubkey, relays, IDENTITIES_D, { ...merged, updatedAt: this.now() })
    if (!this.deps.prefs.get().identityVaultOwnerId) this.deps.prefs.setIdentityVaultOwner(owner)
  }

  private async readIdentityVault(provider: ProviderLike): Promise<{ doc: ReturnType<typeof normalizeIdentityVault>; complete: boolean }> {
    const pubkey = await provider.getPublicKey()
    const relays = await this.deps.resolveRelays(pubkey)
    if (!relays.length) return { doc: normalizeIdentityVault(null), complete: false }
    let events: Event[]
    if (this.deps.relays.queryAuthReport) {
      const report = await this.deps.relays.queryAuthReport(relays, syncFilter(pubkey), (template) => this.signAuth(provider, template))
      if (report.answered !== relays.length) return { doc: normalizeIdentityVault(null), complete: false }
      events = report.events
    } else events = await this.deps.relays.queryAuth(relays, syncFilter(pubkey), (template) => this.signAuth(provider, template))
    const latest = latestByD(events, pubkey).get(IDENTITIES_D)
    if (!latest) return { doc: normalizeIdentityVault(null), complete: true }
    return { doc: normalizeIdentityVault(await this.decrypt(provider, pubkey, latest), this.now()), complete: true }
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

/** Newest valid event for every `d` tag. */
export function latestByD(events: Event[], pubkey: string): Map<string, Event> {
  const latest = new Map<string, Event>()
  for (const event of events) {
    if (event.kind !== SYNC_KIND || event.pubkey !== pubkey) continue
    if (event.content.length > MAX_EVENT_CONTENT) continue
    if (!event.tags.some((tag) => tag[0] === 't' && tag[1] === SYNC_TAG)) continue
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
    if (typeof d !== 'string' || !docKind(d)) continue
    if (!verifyEvent(event)) continue
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
