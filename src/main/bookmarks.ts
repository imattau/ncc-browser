import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Bookmark } from '@shared/types'

interface BookmarkFile {
  version: 1
  bookmarks: Bookmark[]
}

const FILE_VERSION = 1
const MAX_BOOKMARKS = 500

export function isBookmarkable(url: string): boolean {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (value.length === 0 || value.length > 4096) return false
  return /^(ncc:\/\/|https?:\/\/)/i.test(value)
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
 * Small on-disk bookmark list. Bookmarks are user data, never published to Nostr:
 * they can reveal which services a person visits.
 */
export class BookmarkStore {
  private entries: Bookmark[] | null = null

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
      this.flush(entries)
      return this.list()
    }

    entries.unshift({ url: url.trim(), title: normaliseTitle(title, url), createdAt: this.now() })
    if (entries.length > MAX_BOOKMARKS) entries.length = MAX_BOOKMARKS
    this.flush(entries)
    return this.list()
  }

  remove(url: string): Bookmark[] {
    const entries = this.load()
    const index = entries.findIndex((bookmark) => bookmark.url === url)
    if (index !== -1) {
      entries.splice(index, 1)
      this.flush(entries)
    }
    return this.list()
  }

  clear(): void {
    this.entries = []
    this.flush(this.entries)
  }

  private load(): Bookmark[] {
    if (this.entries) return this.entries
    this.entries = []

    try {
      if (!existsSync(this.filePath)) return this.entries
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<BookmarkFile>
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.bookmarks)) return this.entries
      this.entries = parsed.bookmarks.filter(isBookmark).slice(0, MAX_BOOKMARKS)
    } catch (error) {
      console.warn('[bookmarks] ignoring unreadable bookmark file:', error)
    }
    return this.entries
  }

  private flush(entries: Bookmark[]): void {
    const payload: BookmarkFile = { version: FILE_VERSION, bookmarks: entries }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[bookmarks] could not write bookmarks:', error)
    }
  }
}
