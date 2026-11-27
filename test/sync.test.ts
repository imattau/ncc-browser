import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BOOKMARKS_D,
  docKind,
  emptyHistory,
  fitHistory,
  historyD,
  historyWeeks,
  mergeBookmarks,
  mergeHistory,
  mergeIdentityVaults,
  normalizeIdentityVault,
  normalizeBookmarks,
  normalizeHistory,
  normalizeTabs,
  tabsD,
  weekOf,
  type SyncVisit
} from '../src/shared/sync'

const vectors = JSON.parse(readFileSync('test/fixtures/sync-vectors.json', 'utf8')) as {
  bookmarks: { name: string; now: number; local: unknown; remote: unknown; expect: unknown }[]
  history: { name: string; week: number; local: unknown; remote: unknown; expect: unknown }[]
  weeks: {
    name: string
    now: number
    clearedBefore: number
    entries: SyncVisit[]
    expect: unknown
  }[]
}

describe('sync vectors shared with the Rust implementation', () => {
  for (const item of vectors.bookmarks) {
    it(`bookmarks: ${item.name}`, () => {
      const merged = mergeBookmarks(
        normalizeBookmarks(item.local, item.now),
        normalizeBookmarks(item.remote, item.now),
        item.now
      )
      expect(merged).toEqual(item.expect)
    })
  }
  for (const item of vectors.history) {
    it(`history: ${item.name}`, () => {
      const merged = mergeHistory(
        normalizeHistory(item.local, item.week),
        normalizeHistory(item.remote, item.week)
      )
      expect(merged).toEqual(item.expect)
    })
  }
  for (const item of vectors.weeks) {
    it(`weeks: ${item.name}`, () => {
      expect(historyWeeks(item.entries, item.clearedBefore, item.now)).toEqual(item.expect)
    })
  }
})

describe('sync helpers', () => {
  it('validates and merges identity vault entries by public key', () => {
    const keyA = 'a'.repeat(64)
    const keyB = 'b'.repeat(64)
    expect(() => normalizeIdentityVault({ v: 1, entries: [
      { pubkey: 'bad', nsec: 'not-a-key' }
    ] })).toThrow()
    const a = normalizeIdentityVault({ v: 1, entries: [
      { pubkey: keyA, nsec: `nsec1${'a'.repeat(40)}` }
    ] })
    const merged = mergeIdentityVaults(a, { v: 1, entries: [
      { pubkey: keyA, nsec: `nsec1${'a'.repeat(40)}` },
      { pubkey: keyB, nsec: `nsec1${'b'.repeat(40)}` }
    ] })
    expect(merged.entries).toEqual([
      { pubkey: keyA, nsec: `nsec1${'a'.repeat(40)}` },
      { pubkey: keyB, nsec: `nsec1${'b'.repeat(40)}` }
    ])
    expect(() => mergeIdentityVaults(a, { v: 1, entries: [
      { pubkey: keyA, nsec: `nsec1${'c'.repeat(40)}` }
    ] })).toThrow(/conflicting keys/)
  })

  it('starts weeks on Monday', () => {
    const day = 86_400_000
    expect(weekOf(0)).toBe(0)
    expect(weekOf(4 * day)).toBe(1)
    expect(weekOf(11 * day - 1)).toBe(1)
    expect(weekOf(11 * day)).toBe(2)
  })

  it('merges bookmarks the same whichever side is local', () => {
    const a = normalizeBookmarks(
      { entries: [{ url: 'https://a.example/', title: 'A', createdAt: 1, updatedAt: 5 }] },
      10
    )
    const b = normalizeBookmarks(
      {
        entries: [{ url: 'https://a.example/', title: 'A', createdAt: 1, updatedAt: 5, deleted: true }]
      },
      10
    )
    expect(mergeBookmarks(a, b, 10)).toEqual(mergeBookmarks(b, a, 10))
    expect(mergeBookmarks(a, b, 10).entries[0]?.deleted).toBe(true)
  })

  it('keeps the newest visits when a week is too large', () => {
    const doc = emptyHistory(1)
    doc.entries = Array.from({ length: 2000 }, (_, index) => ({
      url: `https://site${index}.example/some/long/path/to/a/page`,
      title: `A page title number ${index}`,
      visits: 1,
      lastVisit: 1_000_000 + index
    })).sort((a, b) => b.lastVisit - a.lastVisit)
    fitHistory(doc)
    expect(JSON.stringify(doc).length).toBeLessThanOrEqual(40_000)
    expect(doc.entries[0]?.lastVisit).toBe(1_001_999)
  })

  it('rejects bad device ids and unsafe tab urls', () => {
    expect(
      normalizeTabs({ v: 1, device: { id: '../x', name: 'n', platform: 'p' }, tabs: [] })
    ).toBeNull()
    const doc = normalizeTabs({
      v: 1,
      device: { id: '0123456789abcdef', name: 'Laptop', platform: 'linux' },
      tabs: [
        { url: 'javascript:alert(1)', title: 'x' },
        { url: 'https://a.example/', title: ' A ' },
        { url: 'nsite://npub1abc.blog/', title: ' Blog ' }
      ]
    })
    expect(doc?.tabs.map((tab) => tab.url)).toEqual([
      'https://a.example/',
      'nsite://npub1abc.blog/'
    ])
  })

  it('round-trips d tags', () => {
    expect(docKind(BOOKMARKS_D)).toEqual({ kind: 'bookmarks' })
    expect(docKind(historyD(2900))).toEqual({ kind: 'history', week: 2900 })
    expect(docKind(tabsD('0123456789abcdef'))).toEqual({
      kind: 'tabs',
      deviceId: '0123456789abcdef'
    })
    expect(docKind('ncc-browser/passwords/v1')).toBeNull()
  })
})
