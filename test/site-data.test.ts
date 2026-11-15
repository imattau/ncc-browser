import { describe, expect, it } from 'vitest'
import {
  emptyCacheInfo,
  formatBytes,
  isSameSite,
  siteIdentityForUrl,
  totalCacheBytes,
  UNSUPPORTED_SITE
} from '../src/shared/site-data'

const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const other = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzzz'

describe('site identity', () => {
  it('keys ncc storage by identity and trust by service', () => {
    const identity = siteIdentityForUrl(`ncc://${npub}/_/web/panel?x=1`)
    expect(identity).toMatchObject({
      origin: `ncc://${npub}`,
      trustKey: `ncc://${npub}/web`,
      label: `ncc://${npub}/web`,
      host: npub,
      service: 'web'
    })
  })

  it('uses the default service for an ncc root address', () => {
    expect(siteIdentityForUrl(`ncc://${npub}/`)?.trustKey).toBe(`ncc://${npub}/addr`)
  })

  it('keeps web origins as both storage and trust keys', () => {
    expect(siteIdentityForUrl('https://example.com:8443/a/b')).toMatchObject({
      origin: 'https://example.com:8443',
      trustKey: 'https://example.com:8443',
      service: null
    })
    expect(siteIdentityForUrl('http://127.0.0.1:3000/')?.origin).toBe('http://127.0.0.1:3000')
  })

  it('rejects pages without a site', () => {
    expect(siteIdentityForUrl('about:blank')).toBeNull()
    expect(siteIdentityForUrl('ncc-ext://abcdef/options.html')).toBeNull()
    expect(siteIdentityForUrl('not a url')).toBeNull()
    expect(UNSUPPORTED_SITE.supported).toBe(false)
  })

  it('ignores the service when comparing storage origins', () => {
    expect(isSameSite(`ncc://${npub}/_/web/one`, `ncc://${npub}`)).toBe(true)
    expect(isSameSite(`ncc://${npub}/_/other/two`, `ncc://${npub}`)).toBe(true)
    expect(isSameSite(`ncc://${other}/_/web/one`, `ncc://${npub}`)).toBe(false)
    expect(isSameSite('https://example.com/', `ncc://${npub}`)).toBe(false)
    expect(isSameSite('https://example.com/a', 'https://example.com')).toBe(true)
    expect(isSameSite('https://a.example.com/', 'https://example.com')).toBe(false)
    expect(isSameSite('about:blank', `ncc://${npub}`)).toBe(false)
  })
})

describe('cache helpers', () => {
  it('sums the per-session sizes', () => {
    expect(totalCacheBytes({ normal: 1, private: 2, tor: 3, extensions: 4 })).toBe(10)
    expect(emptyCacheInfo()).toEqual({ normal: 0, private: 0, tor: 0, extensions: 0, total: 0 })
  })

  it('formats byte counts compactly', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })
})
