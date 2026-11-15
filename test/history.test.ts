import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryStore, MAX_HISTORY_ENTRIES } from '../src/main/history'

const dirs: string[] = []

function store(now = () => Date.now()): { history: HistoryStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-history-'))
  dirs.push(dir)
  const file = join(dir, 'history.json')
  return { history: new HistoryStore(file, now), file }
}

afterEach(() => {
  // Temporary directories are small and the OS reclaims them; nothing to assert.
  dirs.length = 0
})

describe('HistoryStore', () => {
  it('records visits, merges by URL and keeps the newest title', () => {
    let now = 1_000
    const { history } = store(() => now)

    history.record('https://example.com/a', 'First')
    now += 1_000
    history.record('https://example.com/b', 'Second')
    now += 1_000
    history.record('https://example.com/a', 'First updated')

    const entries = history.list()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      url: 'https://example.com/a',
      title: 'First updated',
      visits: 2
    })
    expect(entries[1].url).toBe('https://example.com/b')
  })

  it('updates a title without counting another visit', () => {
    const { history } = store()
    history.record('https://example.com/a', 'https://example.com/a')
    history.setTitle('https://example.com/a', 'Real title')
    expect(history.list()[0]).toMatchObject({ title: 'Real title', visits: 1 })
  })

  it('ignores unsupported and oversized URLs', () => {
    const { history } = store()
    history.record('javascript:alert(1)', 'nope')
    history.record('file:///etc/passwd', 'nope')
    history.record(`https://example.com/${'a'.repeat(5000)}`, 'too long')
    history.record('', 'empty')
    expect(history.size).toBe(0)
  })

  it('searches titles and URLs', () => {
    const { history } = store()
    history.record('https://example.com/nostr', 'Relays explained')
    history.record('https://other.example/', 'Unrelated')
    expect(history.search('relays').map((entry) => entry.url)).toEqual([
      'https://example.com/nostr'
    ])
    expect(history.search('OTHER.example').map((entry) => entry.url)).toEqual([
      'https://other.example/'
    ])
  })

  it('drops entries outside the retention window', () => {
    let now = 1_000_000
    const { history } = store(() => now)
    history.record('https://example.com/old', 'Old')
    now += 200 * 24 * 60 * 60 * 1000
    expect(history.list()).toEqual([])
  })

  it('caps the number of entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncc-history-'))
    const file = join(dir, 'history.json')
    const entries = Array.from({ length: MAX_HISTORY_ENTRIES + 10 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Page ${index}`,
      visits: 1,
      lastVisit: Date.now()
    }))
    writeFileSync(file, JSON.stringify({ version: 1, entries }), 'utf8')

    const history = new HistoryStore(file)
    history.record('https://example.com/new', 'New')
    expect(history.size).toBe(MAX_HISTORY_ENTRIES)
    expect(history.list(1)[0].url).toBe('https://example.com/new')
  })

  it('clears the file and tolerates corruption', () => {
    const { history, file } = store()
    history.record('https://example.com/a', 'A')
    history.clear()
    expect(history.list()).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toEqual([])

    writeFileSync(file, 'not json', 'utf8')
    const broken = new HistoryStore(file)
    expect(broken.list()).toEqual([])
  })

  it('writes an atomic JSON file with a version', () => {
    const { history, file } = store()
    history.record('ncc://npub1test/web/', 'NCC page')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.entries[0]).toMatchObject({ url: 'ncc://npub1test/web/', title: 'NCC page' })
  })
})
