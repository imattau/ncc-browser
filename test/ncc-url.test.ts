import { describe, expect, it } from 'vitest'
import {
  buildNccUrl,
  isValidServiceName,
  looksLikeNccInput,
  parseNccAddress,
  routeNccPath,
  serviceFromReferer,
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

  it('toLoadUrl always ends a service root with a slash', () => {
    expect(toLoadUrl(parseNccAddress(`ncc://${NPUB}/web`))).toBe(`ncc://${NPUB}/web/`)
    expect(toLoadUrl(parseNccAddress(`ncc://${NPUB}/web/`))).toBe(`ncc://${NPUB}/web/`)
    expect(toLoadUrl(parseNccAddress(`ncc://${NPUB}/web/x`))).toBe(`ncc://${NPUB}/web/x`)
    expect(toLoadUrl(parseNccAddress(`ncc://${NPUB}`))).toBe(`ncc://${NPUB}/`)
  })

  it('builds an unambiguous internal URL and a clean display URL', () => {
    const address = parseNccAddress(`ncc://${NPUB}/web/docs?x=1#top`)
    const internal = toInternalUrl(address)
    expect(internal).toBe(`ncc://${NPUB}/_/web/docs?x=1#top`)
    expect(toDisplayUrl(internal)).toBe(`ncc://${NPUB}/web/docs?x=1#top`)

    expect(toDisplayUrl(`ncc://${NPUB}/_/addr/`)).toBe(`ncc://${NPUB}/`)
    expect(toInternalUrl(parseNccAddress(`ncc://${NPUB}`))).toBe(`ncc://${NPUB}/_/addr/`)
    expect(toDisplayUrl('https://example.com')).toBe('https://example.com')
  })
})

describe('routeNccPath', () => {
  it('treats the first segment as the service when nothing is active', () => {
    expect(routeNccPath('/web/docs', null)).toEqual({ service: 'web', path: '/docs' })
    expect(routeNccPath('/', null)).toEqual({ service: 'addr', path: '/' })
  })

  it('routes absolute subresource paths to the active service', () => {
    expect(routeNccPath('/style.css', 'web')).toEqual({ service: 'web', path: '/style.css' })
  })

  it('supports the explicit /_/<service>/ form', () => {
    expect(routeNccPath('/_/web/a/b', null)).toEqual({ service: 'web', path: '/a/b' })
    expect(routeNccPath('/_/web', null)).toEqual({ service: 'web', path: '/' })
  })

  it('prefers the referrer service over the active service', () => {
    expect(routeNccPath('/style.css', 'active', 'referring')).toEqual({
      service: 'referring',
      path: '/style.css'
    })
    expect(routeNccPath('/_/explicit/x', 'active', 'referring')).toEqual({
      service: 'explicit',
      path: '/x'
    })
  })

  it('routes a new document to its requested service, not the previous page service', () => {
    expect(routeNccPath('/npanel/', 'ditto', 'ditto', true)).toEqual({
      service: 'npanel',
      path: '/'
    })
  })

  it('rejects an empty or invalid explicit service', () => {
    expect(routeNccPath('/_/', null)).toBeNull()
    expect(routeNccPath('/_/bad%2Fname', null)).toBeNull()
  })
})

describe('serviceFromReferer', () => {
  it('extracts the service from a same-origin referer', () => {
    expect(serviceFromReferer(`ncc://${NPUB}/web/docs`, NPUB)).toBe('web')
    expect(serviceFromReferer(`ncc://${NPUB}/_/api/v1`, NPUB)).toBe('api')
    expect(serviceFromReferer(`ncc://${NPUB.toUpperCase()}/web/`, NPUB)).toBe('web')
  })

  it('ignores referers from another identity or scheme', () => {
    expect(serviceFromReferer(`ncc://${HEX}/web/`, NPUB)).toBeNull()
    expect(serviceFromReferer('https://example.com/web', NPUB)).toBeNull()
    expect(serviceFromReferer(null, NPUB)).toBeNull()
    expect(serviceFromReferer(`ncc://${NPUB}/`, NPUB)).toBeNull()
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
