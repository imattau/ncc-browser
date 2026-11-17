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
    return {
      identity: this.deps.identity.provider() !== null,
      categories: { ...prefs.categories },
      deviceId: prefs.deviceId,
      deviceName: prefs.deviceName,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      error: this.error,
      devices: this.devices
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
    if (patch.deviceName !== undefined) this.lastTabsKey = ''
    this.notify()
    if (turnedOn || patch.deviceName !== undefined) await this.syncNow()
    return this.status()
  }

  /** Remove another device from the list: its next publish brings it back. */
  async removeDevice(id: string): Promise<SyncStatus> {
    const prefs = this.deps.prefs.get()
    if (id === prefs.deviceId) return this.status()
    const device = this.devices.find((entry) => entry.id === id)
    const provider = this.deps.identity.provider()
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
    const enabled = Object.values(prefs.categories).some(Boolean)
    const provider = this.deps.identity.provider()
    if (!enabled || !provider) {
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
      await this.run(provider)
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
