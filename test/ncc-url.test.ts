import { describe, expect, it } from 'vitest'
import {
  buildNccUrl,
  isValidServiceName,
  looksLikeNccInput,
  parseNccAddress,
  toDisplayUrl,
  toInternalUrl,
  toLoadUrl
} from '../src/shared/ncc-url'

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const HEX = 'a'.repeat(64)

describe('parseNccAddress', () => {
  it('parses the canonical form', () => {
    const address = parseNccAddress(`ncc://${NPUB}/web/docs/page.html?x=1#top`)
    expect(address.pubkey).toBe(NPUB)
    expect(address.service).toBe('web')
    expect(address.path).toBe('/docs/page.html')
    expect(address.search).toBe('?x=1')
    expect(address.hash).toBe('#top')
  })

  it('accepts a missing service segment as the default service', () => {
    expect(parseNccAddress(`ncc://${NPUB}`).service).toBe('addr')
    expect(parseNccAddress(`ncc://${NPUB}/`).service).toBe('addr')
    expect(parseNccAddress(`ncc://${NPUB}/`).path).toBe('/')
  })

  it('normalises the ncc: and scheme-less forms', () => {
    for (const input of [`ncc:${NPUB}/web`, `${NPUB}/web`, `ncc://${NPUB}/web`]) {
      const address = parseNccAddress(input)
      expect(address.pubkey).toBe(NPUB)
      expect(address.service).toBe('web')
    }
  })

  it('lowercases custom-scheme hosts', () => {
    expect(parseNccAddress(`ncc://${NPUB.toUpperCase()}/web`).pubkey).toBe(NPUB)
  })

  it('accepts a hex pubkey', () => {
    const address = parseNccAddress(`ncc://${HEX}/api`)
    expect(address.pubkey).toBe(HEX)
    expect(address.service).toBe('api')
  })

  it('preserves a trailing slash on a nested path', () => {
    expect(parseNccAddress(`ncc://${NPUB}/web/a/`).path).toBe('/a/')
  })

  it('rejects non-ncc schemes and empty input', () => {
    expect(() => parseNccAddress('https://example.com')).toThrow(/ncc/)
    expect(() => parseNccAddress('')).toThrow(/Enter an address/)
  })

  it('parses the explicit /_/<service>/ form', () => {
    const address = parseNccAddress(`ncc://${NPUB}/_/secure/x`)
    expect(address.service).toBe('secure')
    expect(address.path).toBe('/x')
    expect(parseNccAddress(`ncc://${NPUB}/_/secure/`).path).toBe('/')
  })

  it('rejects hosts that are not npubs', () => {
    expect(() => parseNccAddress('ncc://example.com/web')).toThrow(/npub/)
  })

  it('rejects invalid service names', () => {
    expect(() => parseNccAddress(`ncc://${NPUB}/web%2Fevil`)).toThrow(/service name/)
    expect(() => parseNccAddress(`ncc://${NPUB}/-bad`)).toThrow(/service name/)
  })
})

describe('buildNccUrl', () => {
  it('omits the default service and adds a root slash', () => {
    expect(buildNccUrl({ pubkey: NPUB })).toBe(`ncc://${NPUB}/`)
    expect(buildNccUrl({ pubkey: NPUB, service: 'addr', path: '/' })).toBe(`ncc://${NPUB}/`)
  })

  it('keeps the service and path', () => {
    expect(buildNccUrl({ pubkey: NPUB, service: 'web', path: '/docs' })).toBe(
      `ncc://${NPUB}/web/docs`
    )
  })

  it('round-trips through the parser', () => {
    const input = `ncc://${NPUB}/web/a/b?q=1`
    expect(buildNccUrl(parseNccAddress(input))).toBe(input)
  })

  it('uses the host form for loading, so the service is part of the origin', () => {
    expect(toInternalUrl(parseNccAddress(`ncc://${NPUB}/web`))).toBe(`ncc://${NPUB}.web/`)
    expect(toInternalUrl(parseNccAddress(`ncc://${NPUB}/web/x`))).toBe(`ncc://${NPUB}.web/x`)
    expect(toInternalUrl(parseNccAddress(`ncc://${NPUB}`))).toBe(`ncc://${NPUB}.addr/`)
    expect(toLoadUrl(parseNccAddress(`ncc://${NPUB}/web`))).toBe(`ncc://${NPUB}.web/`)
  })

  it('round-trips between the host and display forms', () => {
    const display = `ncc://${NPUB}/web/docs?x=1#top`
    const internal = toInternalUrl(parseNccAddress(display))
    expect(internal).toBe(`ncc://${NPUB}.web/docs?x=1#top`)
    expect(toDisplayUrl(internal)).toBe(display)
    expect(toDisplayUrl(`ncc://${NPUB}.addr/`)).toBe(`ncc://${NPUB}/`)
    expect(toDisplayUrl('https://example.com')).toBe('https://example.com')
  })

  it('parses the host form as an internal address', () => {
    const address = parseNccAddress(`ncc://${NPUB}.web/assets/app.js`)
    expect(address).toMatchObject({
      pubkey: NPUB,
      service: 'web',
      path: '/assets/app.js',
      internal: true
    })
  })

  it('encodes service ids that are not hostname-safe', () => {
    for (const service of ['a.b', 'a~b', 'UPPER', 'x-abc']) {
      const internal = toInternalUrl({ pubkey: NPUB, service, path: '/' })
      const parsed = parseNccAddress(internal)
      expect(parsed.service).toBe(service)
      expect(parsed.path).toBe('/')
      expect(internal).toMatch(/^ncc:\/\/[a-z0-9]+\.x-[a-z2-7]+\/$/)
      expect(toDisplayUrl(internal)).toBe(`ncc://${NPUB}/${service}/`)
    }
  })
})

describe('helpers', () => {
  it('detects ncc input', () => {
    expect(looksLikeNccInput(`ncc://${NPUB}/x`)).toBe(true)
    expect(looksLikeNccInput(`${NPUB}/x`)).toBe(true)
    expect(looksLikeNccInput('https://example.com')).toBe(false)
  })

  it('validates service names', () => {
    expect(isValidServiceName('web')).toBe(true)
    expect(isValidServiceName('my.service-1')).toBe(true)
    expect(isValidServiceName('')).toBe(false)
    expect(isValidServiceName('/evil')).toBe(false)
  })
})
