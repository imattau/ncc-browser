import { describe, expect, it } from 'vitest'
import { joinPaths, rewriteLocation } from '../src/main/ncc/routing'

const PUBKEY = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const ENDPOINT = 'http://203.0.113.42:8080'
const CURRENT = new URL(`ncc://${PUBKEY}.web/docs`)

function context(overrides: Partial<Parameters<typeof rewriteLocation>[1]> = {}) {
  return {
    pubkey: PUBKEY,
    service: 'web',
    current: CURRENT,
    endpointOrigin: ENDPOINT,
    endpointOwners: new Map<string, { pubkey: string; service: string }>(),
    ...overrides
  }
}

describe('joinPaths', () => {
  it('joins endpoint base paths and request paths', () => {
    expect(joinPaths('/', '/docs')).toBe('/docs')
    expect(joinPaths('/app', '/docs')).toBe('/app/docs')
    expect(joinPaths('/app/', '/docs/')).toBe('/app/docs/')
    expect(joinPaths('/app', '/')).toBe('/app/')
    expect(joinPaths('', '/x')).toBe('/x')
  })
})

describe('rewriteLocation', () => {
  it('rewrites a relative redirect into the service namespace', () => {
    expect(rewriteLocation('/login', context())).toBe(`ncc://${PUBKEY}.web/login`)
    expect(rewriteLocation('next', context())).toBe(`ncc://${PUBKEY}.web/next`)
  })

  it('rewrites redirects to the same endpoint origin', () => {
    expect(rewriteLocation(`${ENDPOINT}/home?x=1#top`, context())).toBe(
      `ncc://${PUBKEY}.web/home?x=1#top`
    )
  })

  it('rewrites redirects to the same owner but another endpoint', () => {
    const owners = new Map([[`https://other.example`, { pubkey: PUBKEY, service: 'api' }]])
    expect(rewriteLocation('https://other.example/v1', context({ endpointOwners: owners }))).toBe(
      `ncc://${PUBKEY}.api/v1`
    )
  })

  it('leaves clearnet redirects alone', () => {
    expect(rewriteLocation('https://example.com/out', context())).toBe('https://example.com/out')
  })

  it('does not let a service hijack another npub', () => {
    const other = 'npub1other'
    expect(rewriteLocation(`ncc://${other}/web/`, context())).toBe(`ncc://${other}/web/`)
    const owners = new Map([[`https://evil.example`, { pubkey: other, service: 'web' }]])
    expect(rewriteLocation('https://evil.example/x', context({ endpointOwners: owners }))).toBe(
      'https://evil.example/x'
    )
  })

})
