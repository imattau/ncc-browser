import { describe, expect, it } from 'vitest'
import {
  classifyOmniboxInput,
  looksLikeSearch,
  omniboxActionLabel,
  parseHostInput,
  type OmniboxContext
} from '../src/shared/omnibox'
import {
  buildSearchUrl,
  resolveSearchTemplate,
  searxTemplate,
  validateSearchTemplate
} from '../src/shared/search'

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const HEX = 'a'.repeat(64)

function context(overrides: Partial<OmniboxContext> = {}): OmniboxContext {
  return {
    engine: 'duckduckgo',
    custom: '',
    useOnionSearch: true,
    httpsMode: 'prefer',
    tabKind: 'normal',
    ...overrides
  }
}

describe('classifyOmniboxInput', () => {
  it('treats npubs, hex ids and ncc:// as NCC addresses', () => {
    expect(classifyOmniboxInput(NPUB, context())).toEqual({
      kind: 'ncc',
      url: `ncc://${NPUB}/`
    })
    expect(classifyOmniboxInput(`${NPUB}/web`, context())).toEqual({
      kind: 'ncc',
      url: `ncc://${NPUB}/web/`
    })
    expect(classifyOmniboxInput(HEX, context())).toEqual({ kind: 'ncc', url: `ncc://${HEX}/` })
    expect(classifyOmniboxInput(`ncc://${NPUB}/web/docs?x=1#top`, context())).toEqual({
      kind: 'ncc',
      url: `ncc://${NPUB}/web/docs?x=1#top`
    })
    expect(classifyOmniboxInput('ncc:npub1bad', context()).kind).toBe('invalid')
  })

  it('adds https to bare clearnet domains and keeps ports and paths', () => {
    expect(classifyOmniboxInput('example.com', context())).toEqual({
      kind: 'web',
      url: 'https://example.com'
    })
    expect(classifyOmniboxInput('news.example.co.uk:8443/a?b=1', context())).toEqual({
      kind: 'web',
      url: 'https://news.example.co.uk:8443/a?b=1'
    })
    expect(classifyOmniboxInput('www.example.com', context())).toEqual({
      kind: 'web',
      url: 'https://www.example.com'
    })
  })

  it('uses plain http for loopback, IP literals, .local and .onion', () => {
    expect(classifyOmniboxInput('localhost:5173/dashboard', context())).toEqual({
      kind: 'web',
      url: 'http://localhost:5173/dashboard'
    })
    expect(classifyOmniboxInput('127.0.0.1:8080', context())).toEqual({
      kind: 'web',
      url: 'http://127.0.0.1:8080'
    })
    expect(classifyOmniboxInput('[::1]:3000', context())).toEqual({
      kind: 'web',
      url: 'http://[::1]:3000'
    })
    expect(classifyOmniboxInput('printer.local', context())).toEqual({
      kind: 'web',
      url: 'http://printer.local'
    })
    expect(classifyOmniboxInput('abc.onion/hello', context())).toEqual({
      kind: 'web',
      url: 'http://abc.onion/hello'
    })
  })

  it('searches for words, phrases and single labels', () => {
    const phrase = classifyOmniboxInput('what is nostr', context())
    expect(phrase.kind).toBe('search')
    if (phrase.kind === 'search') {
      expect(phrase.url).toBe('https://duckduckgo.com/?q=what%20is%20nostr')
      expect(phrase.engineLabel).toBe('DuckDuckGo')
    }

    expect(classifyOmniboxInput('nostr', context()).kind).toBe('search')
    expect(classifyOmniboxInput('v1.2', context()).kind).toBe('search')
    expect(classifyOmniboxInput('?localhost', context()).kind).toBe('search')
    expect(looksLikeSearch('hello')).toBe(true)
    expect(looksLikeSearch('example.com')).toBe(false)
    expect(looksLikeSearch(NPUB)).toBe(false)
  })

  it('passes explicit http(s) URLs through and rejects other schemes', () => {
    expect(classifyOmniboxInput('http://example.com/a', context())).toEqual({
      kind: 'web',
      url: 'http://example.com/a'
    })
    expect(classifyOmniboxInput('https://example.com/a', context())).toEqual({
      kind: 'web',
      url: 'https://example.com/a'
    })
    expect(classifyOmniboxInput('mailto:someone@example.com', context())).toMatchObject({
      kind: 'invalid',
      code: 'unsupported-scheme'
    })
    expect(classifyOmniboxInput('javascript:alert(1)', context()).kind).toBe('invalid')
  })

  it('never sends a private key anywhere', () => {
    const nsec = 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    expect(classifyOmniboxInput(nsec, context())).toMatchObject({
      kind: 'invalid',
      code: 'secret-key'
    })
    expect(classifyOmniboxInput(`ncryptsec1${'a'.repeat(120)}`, context())).toMatchObject({
      kind: 'invalid',
      code: 'secret-key'
    })
    expect(classifyOmniboxInput(`my key is ${nsec}`, context())).toMatchObject({
      kind: 'invalid',
      code: 'secret-key'
    })
  })

  it('rejects invalid ports and out-of-range IPv4 addresses', () => {
    expect(classifyOmniboxInput('example.com:70000', context())).toMatchObject({
      kind: 'invalid',
      code: 'invalid-address'
    })
    expect(classifyOmniboxInput('300.1.1.1', context()).kind).toBe('invalid')
  })

  it('describes what Enter will do', () => {
    expect(omniboxActionLabel(classifyOmniboxInput('nostr relays', context()))).toBe(
      'Search DuckDuckGo for "nostr relays"'
    )
    expect(omniboxActionLabel(classifyOmniboxInput('example.com', context()))).toBe(
      'Open https://example.com'
    )
  })
})

describe('parseHostInput', () => {
  it('returns null for non-host text', () => {
    expect(parseHostInput('hello world')).toBeNull()
    expect(parseHostInput('nostr')).toBeNull()
    expect(parseHostInput('https://example.com')).toBeNull()
    expect(parseHostInput('someone@example.com')).toBeNull()
  })
})

describe('search engines', () => {
  it('validates templates', () => {
    expect(validateSearchTemplate('https://example.com/search?q=%s').ok).toBe(true)
    expect(validateSearchTemplate('https://example.com/search').ok).toBe(false)
    expect(validateSearchTemplate('http://example.com/?q=%s').ok).toBe(false)
    expect(validateSearchTemplate('http://127.0.0.1:8888/?q=%s').ok).toBe(true)
    expect(validateSearchTemplate('ftp://example.com/?q=%s').ok).toBe(false)
  })

  it('builds a SearXNG template from an instance URL', () => {
    const result = searxTemplate('searx.example')
    expect(result).toEqual({ ok: true, template: 'https://searx.example/search?q=%s' })
    expect(searxTemplate('https://searx.example/search')).toEqual({
      ok: true,
      template: 'https://searx.example/search?q=%s'
    })
    expect(searxTemplate('http://searx.example').ok).toBe(false)
    expect(searxTemplate('http://127.0.0.1:8888').ok).toBe(true)
  })

  it('uses the built-in engine, or falls back to DuckDuckGo when misconfigured', () => {
    expect(buildSearchUrl({ engine: 'brave', custom: '', useOnionSearch: true }, 'x')).toBe(
      'https://search.brave.com/search?q=x'
    )
    expect(buildSearchUrl({ engine: 'custom', custom: '', useOnionSearch: true }, 'x')).toBe(
      'https://duckduckgo.com/?q=x'
    )
    const resolved = resolveSearchTemplate({ engine: 'custom', custom: 'nope', useOnionSearch: true })
    expect(resolved.error).toBeTruthy()
    expect(resolved.label).toBe('DuckDuckGo')
  })

  it('switches DuckDuckGo to its onion endpoint only inside Tor tabs', () => {
    const settings = { engine: 'duckduckgo' as const, custom: '', useOnionSearch: true }
    expect(buildSearchUrl(settings, 'nostr', 'tor')).toContain('.onion')
    expect(buildSearchUrl(settings, 'nostr', 'normal')).toBe(
      'https://duckduckgo.com/?q=nostr'
    )
    expect(
      buildSearchUrl({ ...settings, useOnionSearch: false }, 'nostr', 'tor')
    ).toBe('https://duckduckgo.com/?q=nostr')
    expect(buildSearchUrl({ engine: 'brave', custom: '', useOnionSearch: true }, 'nostr', 'tor')).toBe(
      'https://search.brave.com/search?q=nostr'
    )
  })
})
