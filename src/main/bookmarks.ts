import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Bookmark } from '@shared/types'
import {
  TOMBSTONE_TTL_MS,
  emptyBookmarks,
  type BookmarkDoc,
  type SyncBookmark
} from '@shared/sync'

/** A removed bookmark, kept so the removal reaches the other devices. */
interface Tombstone {
  url: string
  createdAt: number
  deletedAt: number
}

interface BookmarkFile {
  version: 1
  bookmarks: Bookmark[]
  tombstones?: Tombstone[]
}

const FILE_VERSION = 1
const MAX_BOOKMARKS = 500

export function isBookmarkable(url: string): boolean {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (value.length === 0 || value.length > 4096) return false
  return /^(ncc:\/\/|nsite:\/\/|https?:\/\/)/i.test(value)
}

function normaliseTitle(title: string, url: string): string {
  const value = title.trim().replace(/\s+/g, ' ')
  if (!value) return url
  return value.length > 300 ? `${value.slice(0, 300)}…` : value
}

function isBookmark(value: unknown): value is Bookmark {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<Bookmark>
  return (
    typeof entry.url === 'string' &&
    isBookmarkable(entry.url) &&
    typeof entry.title === 'string' &&
    typeof entry.createdAt === 'number'
  )
}

/**
 * Small on-disk bookmark list. Bookmarks can reveal which services a person visits, so
 * they leave the device only when Sync is switched on, and then only as a NIP-44
 * document encrypted to the person's own key (see `src/main/sync`).
 */
export class BookmarkStore {
  private entries: Bookmark[] | null = null
  private tombstones: Tombstone[] = []
  /** Called after every change a person made, so sync can follow. */
  onChange: (() => void) | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  list(): Bookmark[] {
    return [...this.load()]
  }

  has(url: string): boolean {
    return this.load().some((bookmark) => bookmark.url === url)
  }

  /** Add or remove, whichever the current state implies. */
  toggle(url: string, title: string): Bookmark[] {
    return this.has(url) ? this.remove(url) : this.add(url, title)
  }

  add(url: string, title: string): Bookmark[] {
    if (!isBookmarkable(url)) return this.list()
    const entries = this.load()
    const existing = entries.find((bookmark) => bookmark.url === url)
    if (existing) {
      existing.title = normaliseTitle(title, url)
      existing.updatedAt = this.now()
      this.flush(entries)
      return this.list()
    }

    const at = this.now()
    this.tombstones = this.tombstones.filter((tombstone) => tombstone.url !== url.trim())
    entries.unshift({
      url: url.trim(),
      title: normaliseTitle(title, url),
      createdAt: at,
      updatedAt: at
    })
    if (entries.length > MAX_BOOKMARKS) entries.length = MAX_BOOKMARKS
    this.flush(entries)
    return this.list()
  }

  remove(url: string): Bookmark[] {
    const entries = this.load()
    const index = entries.findIndex((bookmark) => bookmark.url === url)
    if (index !== -1) {
      const [removed] = entries.splice(index, 1)
      if (removed) {
        this.tombstones = this.tombstones.filter((tombstone) => tombstone.url !== removed.url)
        this.tombstones.push({
          url: removed.url,
          createdAt: removed.createdAt,
          deletedAt: this.now()
        })
      }
      this.flush(entries)
    }
    return this.list()
  }

  clear(): void {
    const at = this.now()
    for (const bookmark of this.load()) {
      this.tombstones.push({ url: bookmark.url, createdAt: bookmark.createdAt, deletedAt: at })
    }
    this.entries = []
    this.flush(this.entries)
  }

  /** The bookmarks and removals as a sync document. */
  syncDoc(): BookmarkDoc {
    const entries: SyncBookmark[] = this.load().map((bookmark) => ({
      url: bookmark.url,
      title: bookmark.title,
      createdAt: bookmark.createdAt,
      updatedAt: bookmark.updatedAt ?? bookmark.createdAt
    }))
    for (const tombstone of this.tombstones) {
      entries.push({
        url: tombstone.url,
        title: tombstone.url,
        createdAt: tombstone.createdAt,
        updatedAt: tombstone.deletedAt,
        deleted: true
      })
    }
    return { ...emptyBookmarks(), entries }
  }

  /** Adopt a merged document. Does not call `onChange`: the merge came from sync. */
  applySync(doc: BookmarkDoc): boolean {
    const live: Bookmark[] = doc.entries
      .filter((entry) => !entry.deleted)
      .map((entry) => ({
        url: entry.url,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      }))
      .slice(0, MAX_BOOKMARKS)
    const tombstones: Tombstone[] = doc.entries
      .filter((entry) => entry.deleted)
      .map((entry) => ({ url: entry.url, createdAt: entry.createdAt, deletedAt: entry.updatedAt }))
    const before = JSON.stringify([this.load(), this.tombstones])
    if (before === JSON.stringify([live, tombstones])) return false
    this.tombstones = tombstones
    this.entries = live
    this.flush(live, false)
    return true
  }

  private load(): Bookmark[] {
    if (this.entries) return this.entries
    this.entries = []

    try {
      if (!existsSync(this.filePath)) return this.entries
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<BookmarkFile>
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.bookmarks)) return this.entries
      this.entries = parsed.bookmarks.filter(isBookmark).slice(0, MAX_BOOKMARKS)
      const cutoff = this.now() - TOMBSTONE_TTL_MS
      this.tombstones = Array.isArray(parsed.tombstones)
        ? parsed.tombstones.filter(
            (tombstone) =>
              tombstone &&
              typeof tombstone.url === 'string' &&
              isBookmarkable(tombstone.url) &&
              typeof tombstone.createdAt === 'number' &&
              typeof tombstone.deletedAt === 'number' &&
              tombstone.deletedAt >= cutoff
          )
        : []
    } catch (error) {
      console.warn('[bookmarks] ignoring unreadable bookmark file:', error)
    }
    return this.entries
  }

  private flush(entries: Bookmark[], notify = true): void {
    const cutoff = this.now() - TOMBSTONE_TTL_MS
    this.tombstones = this.tombstones.filter((tombstone) => tombstone.deletedAt >= cutoff)
    const payload: BookmarkFile = {
      version: FILE_VERSION,
      bookmarks: entries,
      ...(this.tombstones.length ? { tombstones: this.tombstones } : {})
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[bookmarks] could not write bookmarks:', error)
    }
    if (notify) this.onChange?.()
  }
}
