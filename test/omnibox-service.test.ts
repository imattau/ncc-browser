import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BookmarkStore } from '../src/main/bookmarks'
import { HistoryStore } from '../src/main/history'
import { OmniboxService, type OmniboxTab } from '../src/main/omnibox'
import { DEFAULT_APPEARANCE, DEFAULT_PASSWORD_CONFIG, type AppConfig } from '../src/shared/types'

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const NOW = 1_700_000_000_000

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    relays: [],
    gossip: true,
    anchorRequired: false,
    preferTor: false,
    torMode: 'auto',
    torSocks: 'socks5://127.0.0.1:9050',
    httpsMode: 'prefer',
    warnInsecure: false,
    httpExceptions: [],
    searchEngine: 'duckduckgo',
    searchEngineCustom: '',
    useOnionSearch: true,
    appearance: { ...DEFAULT_APPEARANCE },
    passwords: { ...DEFAULT_PASSWORD_CONFIG },
    ...overrides
  }
}

function service(overrides: Partial<AppConfig> = {}): {
  omnibox: OmniboxService
  history: HistoryStore
  bookmarks: BookmarkStore
} {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-omnibox-'))
  const history = new HistoryStore(join(dir, 'history.json'), () => NOW)
  const bookmarks = new BookmarkStore(join(dir, 'bookmarks.json'), () => NOW)
  const omnibox = new OmniboxService({
    history,
    bookmarks,
    config: () => config(overrides),
    now: () => NOW
  })
  return { omnibox, history, bookmarks }
}

describe('OmniboxService', () => {
  it('puts the action row first and describes it', () => {
    const { omnibox } = service()
    const rows = omnibox.suggest('nostr relays', 'normal')
    expect(rows[0]).toMatchObject({ kind: 'action', icon: 'search' })
    expect(rows[0].title).toBe('Search DuckDuckGo for "nostr relays"')

    const urls = omnibox.suggest('example.com', 'normal')
    expect(urls[0]).toMatchObject({ kind: 'action', url: 'https://example.com' })

    const ncc = omnibox.suggest(NPUB, 'normal')
    expect(ncc[0]).toMatchObject({ kind: 'action', url: `ncc://${NPUB}/` })
  })

  it('returns no rows for a pasted private key', () => {
    const { omnibox } = service()
    const nsec = `nsec1${'q'.repeat(58)}`
    expect(omnibox.suggest(nsec, 'normal')).toEqual([])
  })

  it('matches bookmarks and history, with bookmarks winning duplicates', () => {
    const { omnibox, history, bookmarks } = service()
    bookmarks.add('https://example.com/nostr', 'Nostr guide')
    history.record('https://example.com/nostr', 'Nostr guide')
    history.record('https://example.com/relays', 'Relay notes')

    const rows = omnibox.suggest('nostr', 'normal')
    const kinds = rows.map((row) => row.kind)
    expect(kinds).toContain('bookmark')
    expect(kinds).not.toContain('history')
    expect(rows.find((row) => row.kind === 'bookmark')?.url).toBe('https://example.com/nostr')

    const relayRows = omnibox.suggest('relay', 'normal')
    expect(relayRows.some((row) => row.kind === 'history' && row.url.endsWith('/relays'))).toBe(
      true
    )
  })

  it('keeps history out of private and Tor tabs but keeps bookmarks', () => {
    const { omnibox, history, bookmarks } = service()
    bookmarks.add('https://example.com/nostr', 'Nostr guide')
    history.record('https://example.com/secret', 'Private-ish page')

    for (const kind of ['private', 'tor'] as const) {
      const rows = omnibox.suggest('nostr', kind)
      expect(rows.some((row) => row.kind === 'bookmark')).toBe(true)
      expect(rows.some((row) => row.kind === 'history')).toBe(false)

      const secretRows = omnibox.suggest('secret', kind)
      expect(secretRows.some((row) => row.kind === 'history')).toBe(false)
    }
  })

  it('only suggests tabs from the same tab kind', () => {
    const { omnibox } = service()
    const tabs: OmniboxTab[] = [
      { id: 't1', kind: 'normal', title: 'Normal nostr', url: 'https://example.com/nostr' },
      { id: 't2', kind: 'private', title: 'Private nostr', url: 'https://example.com/private' },
      { id: 't3', kind: 'tor', title: 'Tor nostr', url: 'https://example.com/tor' }
    ]

    const normal = omnibox.suggest('nostr', 'normal', tabs)
    expect(normal.some((row) => row.kind === 'tab' && row.tabId === 't1')).toBe(true)
    expect(normal.some((row) => row.tabId === 't2' || row.tabId === 't3')).toBe(false)

    const privateRows = omnibox.suggest('nostr', 'private', tabs)
    expect(privateRows.some((row) => row.tabId === 't2')).toBe(true)
    expect(privateRows.some((row) => row.tabId === 't1')).toBe(false)
  })

  it('shows recent sites and bookmarks for empty input', () => {
    const { omnibox, history, bookmarks } = service()
    bookmarks.add('https://example.com/bookmark', 'A bookmark')
    history.record('https://example.com/recent', 'Recent')

    const rows = omnibox.suggest('', 'normal')
    expect(rows.map((row) => row.url)).toEqual([
      'https://example.com/recent',
      'https://example.com/bookmark'
    ])

    const privateRows = omnibox.suggest('', 'private')
    expect(privateRows.map((row) => row.url)).toEqual(['https://example.com/bookmark'])
  })

  it('completes services seen for a typed npub', () => {
    const { omnibox, history, bookmarks } = service()
    history.record(`ncc://${NPUB}/web/`, 'Web service')
    bookmarks.add(`ncc://${NPUB}/blog/`, 'Blog')

    const rows = omnibox.suggest(`ncc://${NPUB}/`, 'normal')
    const services = rows.filter((row) => row.kind === 'service').map((row) => row.url)
    expect(services).toContain(`ncc://${NPUB}/web/`)
    expect(services).toContain(`ncc://${NPUB}/blog/`)

    const partial = omnibox.suggest(`ncc://${NPUB}/w`, 'normal')
    expect(partial.some((row) => row.kind === 'service' && row.url.endsWith('/web/'))).toBe(true)
    expect(partial.some((row) => row.kind === 'service' && row.url.endsWith('/blog/'))).toBe(false)
  })

  it('records visits and titles only for normal tabs', () => {
    const { omnibox, history } = service()
    omnibox.recordVisit('https://example.com/normal', 'Normal', 'normal')
    omnibox.recordVisit('https://example.com/private', 'Private', 'private')
    omnibox.recordVisit('https://example.com/tor', 'Tor', 'tor')
    omnibox.updateTitle('https://example.com/normal', 'Normal title', 'normal')
    omnibox.updateTitle('https://example.com/private', 'Should not appear', 'private')

    const urls = history.list().map((entry) => entry.url)
    expect(urls).toEqual(['https://example.com/normal'])
    expect(history.list()[0].title).toBe('Normal title')

    omnibox.clearHistory()
    expect(history.size).toBe(0)
  })

  it('uses the configured engine and Tor onion search', () => {
    const brave = service({ searchEngine: 'brave' })
    expect(brave.omnibox.suggest('nostr', 'normal')[0].url).toBe(
      'https://search.brave.com/search?q=nostr'
    )

    const tor = service()
    expect(tor.omnibox.suggest('nostr', 'tor')[0].url).toContain('.onion')
    expect(tor.omnibox.suggest('nostr', 'normal')[0].url).toBe(
      'https://duckduckgo.com/?q=nostr'
    )
  })
})
