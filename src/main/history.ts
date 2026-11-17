/**
 * Local browsing history for address-bar suggestions.
 *
 * Only normal tabs are ever recorded. Private and Tor sessions never touch this file.
 * Nothing leaves the device unless history sync is switched on, and then only the last
 * few weeks as NIP-44 documents encrypted to the person's own key (`src/main/sync`).
 * Titles are user-visible page titles, not NCC resolution details.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SyncVisit } from '@shared/sync'

export interface BrowsingEntry {
  url: string
  title: string
  visits: number
  /** Epoch milliseconds. */
  lastVisit: number
}

interface HistoryFile {
  version: 1
  entries: BrowsingEntry[]
  /** Visits at or before this time were cleared; sync spreads that to other devices. */
  clearedBefore?: number
}

const FILE_VERSION = 1
export const MAX_HISTORY_ENTRIES = 3000
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000
const MAX_URL_LENGTH = 4096
const MAX_TITLE_LENGTH = 300

export function isRecordableUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (!value || value.length > MAX_URL_LENGTH) return false
  return /^(ncc:\/\/|https?:\/\/)/i.test(value)
}

function normaliseTitle(title: unknown, url: string): string {
  const value = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : ''
  if (!value) return url
  return value.length > MAX_TITLE_LENGTH ? `${value.slice(0, MAX_TITLE_LENGTH)}…` : value
}

function isEntry(value: unknown): value is BrowsingEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<BrowsingEntry>
  return (
    isRecordableUrl(entry.url) &&
    typeof entry.title === 'string' &&
    typeof entry.visits === 'number' &&
    Number.isFinite(entry.visits) &&
    typeof entry.lastVisit === 'number' &&
    Number.isFinite(entry.lastVisit)
  )
}

export class HistoryStore {
  private entries: BrowsingEntry[] | null = null
  private cleared = 0
  /** Called after every change a person made, so sync can follow. */
  onChange: (() => void) | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  get size(): number {
    return this.load().length
  }

  /** Record a visit, merging by URL and keeping the newest title. */
  record(url: string, title = ''): void {
    if (!isRecordableUrl(url)) return
    const value = url.trim()
    const entries = this.load()
    const at = this.now()
    const existing = entries.find((entry) => entry.url === value)
    if (existing) {
      existing.visits += 1
      existing.lastVisit = at
      if (title.trim()) existing.title = normaliseTitle(title, value)
    } else {
      entries.unshift({
        url: value,
        title: normaliseTitle(title, value),
        visits: 1,
        lastVisit: at
      })
    }
    this.prune(entries, at)
    this.flush(entries)
  }

  /** Update the title of an existing entry without counting another visit. */
  setTitle(url: string, title: string): void {
    if (!isRecordableUrl(url) || !title.trim()) return
    const entry = this.load().find((item) => item.url === url.trim())
    if (!entry) return
    const next = normaliseTitle(title, entry.url)
    if (next === entry.title) return
    entry.title = next
    this.flush(this.load())
  }

  /** Newest first. Does not include entries older than the retention window. */
  list(limit = 100): BrowsingEntry[] {
    const entries = this.load()
    this.prune(entries, this.now())
    return [...entries]
      .sort((a, b) => b.lastVisit - a.lastVisit)
      .slice(0, Math.max(0, limit))
  }

  search(query: string, limit = 20): BrowsingEntry[] {
    const value = query.trim().toLowerCase()
    if (!value) return this.list(limit)
    return this.list(Number.POSITIVE_INFINITY).filter(
      (entry) =>
        entry.url.toLowerCase().includes(value) || entry.title.toLowerCase().includes(value)
    ).slice(0, Math.max(0, limit))
  }

  clear(): void {
    this.cleared = this.now()
    this.entries = []
    this.flush(this.entries)
  }

  get clearedBefore(): number {
    this.load()
    return this.cleared
  }

  /** Entries in the shape sync merges. */
  syncEntries(): SyncVisit[] {
    return this.load().map((entry) => ({
      url: entry.url,
      title: entry.title,
      visits: entry.visits,
      lastVisit: entry.lastVisit
    }))
  }

  /** Adopt a merged history. Returns true when anything changed. */
  applySync(entries: SyncVisit[], clearedBefore: number): boolean {
    const current = this.load()
    const byUrl = new Map<string, BrowsingEntry>(current.map((entry) => [entry.url, entry]))
    const cleared = Math.max(this.cleared, clearedBefore)
    let changed = cleared !== this.cleared
    this.cleared = cleared
    for (const entry of entries) {
      if (entry.lastVisit <= cleared || !isRecordableUrl(entry.url)) continue
      const existing = byUrl.get(entry.url)
      if (!existing) {
        byUrl.set(entry.url, { ...entry })
        changed = true
        continue
      }
      if (
        entry.lastVisit > existing.lastVisit ||
        entry.visits > existing.visits ||
        (entry.lastVisit === existing.lastVisit && entry.title !== existing.title)
      ) {
        existing.visits = Math.max(existing.visits, entry.visits)
        if (entry.lastVisit >= existing.lastVisit) existing.title = entry.title
        existing.lastVisit = Math.max(existing.lastVisit, entry.lastVisit)
        changed = true
      }
    }
    const next = [...byUrl.values()].filter((entry) => entry.lastVisit > cleared)
    if (next.length !== byUrl.size) changed = true
    if (!changed) return false
    next.sort((a, b) => b.lastVisit - a.lastVisit)
    this.entries = next
    this.prune(this.entries, this.now())
    this.flush(this.entries, false)
    return true
  }

  private load(): BrowsingEntry[] {
    if (this.entries) return this.entries
    this.entries = []
    try {
      if (!existsSync(this.filePath)) return this.entries
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<HistoryFile>
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries)) return this.entries
      this.entries = parsed.entries.filter(isEntry).slice(0, MAX_HISTORY_ENTRIES)
      this.cleared =
        typeof parsed.clearedBefore === 'number' && Number.isFinite(parsed.clearedBefore)
          ? parsed.clearedBefore
          : 0
    } catch (error) {
      console.warn('[history] ignoring unreadable history file:', error)
    }
    return this.entries
  }

  private prune(entries: BrowsingEntry[], at: number): void {
    const cutoff = at - MAX_AGE_MS
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if ((entries[index]?.lastVisit ?? 0) < cutoff) entries.splice(index, 1)
    }
    if (entries.length > MAX_HISTORY_ENTRIES) entries.length = MAX_HISTORY_ENTRIES
  }

  private flush(entries: BrowsingEntry[], notify = true): void {
    const payload: HistoryFile = {
      version: FILE_VERSION,
      entries,
      ...(this.cleared > 0 ? { clearedBefore: this.cleared } : {})
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[history] could not write history:', error)
    }
    if (notify) this.onChange?.()
  }
}
