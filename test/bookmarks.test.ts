import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarkStore, isBookmarkable } from '../src/main/bookmarks'

const directories: string[] = []

function store(now = () => 1000): { store: BookmarkStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ncc-bookmarks-'))
  directories.push(directory)
  const path = join(directory, 'bookmarks.json')
  return { store: new BookmarkStore(path, now), path }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('isBookmarkable', () => {
  it('accepts ncc, nsite and web addresses only', () => {
    expect(isBookmarkable('ncc://npub1abc/web')).toBe(true)
    expect(isBookmarkable('nsite://npub1abc.blog/')).toBe(true)
    expect(isBookmarkable('NSITE://npub1abc.blog/')).toBe(true)
    expect(isBookmarkable('https://example.com')).toBe(true)
    expect(isBookmarkable('http://example.com')).toBe(true)
    expect(isBookmarkable('javascript:alert(1)')).toBe(false)
    expect(isBookmarkable('file:///etc/passwd')).toBe(false)
    expect(isBookmarkable('')).toBe(false)
  })
})

describe('BookmarkStore', () => {
  it('adds, deduplicates and toggles', () => {
    const { store: bookmarks } = store()
    bookmarks.add('ncc://npub1abc/web', 'Web')
    bookmarks.add('nsite://npub1abc.blog/', 'Blog')
    expect(bookmarks.list()).toHaveLength(2)
    bookmarks.toggle('nsite://npub1abc.blog/', 'Blog')
    bookmarks.add('ncc://npub1abc/web', 'Renamed')
    expect(bookmarks.list()).toHaveLength(1)
    expect(bookmarks.list()[0].title).toBe('Renamed')

    expect(bookmarks.toggle('ncc://npub1abc/web', 'Web')).toHaveLength(0)
    expect(bookmarks.toggle('ncc://npub1abc/web', 'Web')).toHaveLength(1)
  })

  it('keeps newest first and persists atomically', () => {
    const { store: bookmarks, path } = store()
    bookmarks.add('ncc://one/web', 'One')
    bookmarks.add('https://two.example', 'Two')
    expect(bookmarks.list().map((entry) => entry.title)).toEqual(['Two', 'One'])

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.bookmarks).toHaveLength(2)

    const reloaded = new BookmarkStore(path)
    expect(reloaded.list().map((entry) => entry.title)).toEqual(['Two', 'One'])
  })

  it('rejects unsafe urls and ignores corrupt files', () => {
    const { store: bookmarks, path } = store()
    bookmarks.add('javascript:alert(1)', 'Nope')
    expect(bookmarks.list()).toHaveLength(0)

    writeFileSync(path, '{not json', 'utf8')
    const reloaded = new BookmarkStore(path)
    expect(reloaded.list()).toEqual([])
  })

  it('bounds the title length', () => {
    const { store: bookmarks } = store()
    bookmarks.add('https://example.com', 'x'.repeat(500))
    expect(bookmarks.list()[0].title.length).toBe(301)
  })
})
