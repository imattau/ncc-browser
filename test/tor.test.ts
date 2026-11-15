import { describe, expect, it } from 'vitest'
import type { ResolvedEndpoint } from '../src/shared/types'
import {
  hasOnionEndpoint,
  selectTransportEndpoints,
  TransportPolicy
} from '../src/main/ncc/transport'
import { isAllowedTorRedirect, isAllowedTorUrl, isOnionHost } from '../src/main/tor/guard'
import { buildTorPac, normalizeTorProxy, socksEndpoint } from '../src/main/tor/proxy'

function endpoint(url: string, family: ResolvedEndpoint['family']): ResolvedEndpoint {
  return {
    url,
    protocol: url.startsWith('https') ? 'https' : 'http',
    priority: 1,
    family,
    k: null
  }
}

describe('normalizeTorProxy', () => {
  it('normalizes socks5 and socks5h URLs', () => {
    expect(normalizeTorProxy('socks5://127.0.0.1:9050')).toBe('socks5://127.0.0.1:9050')
    expect(normalizeTorProxy('socks5h://localhost')).toBe('socks5://localhost:9050')
  })

  it('rejects non-SOCKS, credentials and paths', () => {
    expect(() => normalizeTorProxy('http://127.0.0.1:9050')).toThrow(/socks5/)
    expect(() => normalizeTorProxy('socks5://user:pass@127.0.0.1:9050')).toThrow(/Authenticated/)
    expect(() => normalizeTorProxy('socks5://127.0.0.1:9050/proxy')).toThrow(/path/)
    expect(() => normalizeTorProxy('')).toThrow(/SOCKS5/)
  })

  it('parses the host and port', () => {
    expect(socksEndpoint('socks5://[::1]:9150')).toEqual({ host: '::1', port: 9150 })
  })
})

describe('buildTorPac', () => {
  it('sends only onion hosts to the proxy', () => {
    const pac = buildTorPac('socks5://127.0.0.1:9050')
    expect(pac).toContain('dnsDomainIs(host, ".onion")')
    expect(pac).toContain('SOCKS5 127.0.0.1:9050')
    expect(pac).toContain('return "DIRECT"')
  })
})

describe('selectTransportEndpoints', () => {
  const direct = endpoint('http://192.0.2.10:8080/', 'ipv4')
  const onion = endpoint('http://example.onion:8080/', 'onion')

  it('never tries onion endpoints in direct mode', () => {
    expect(selectTransportEndpoints([direct, onion], false)).toEqual({
      candidates: [direct],
      onionAvailable: true,
      onionOnly: false
    })
  })

  it('uses only onion endpoints in Tor mode', () => {
    expect(selectTransportEndpoints([direct, onion], true)).toEqual({
      candidates: [onion],
      onionAvailable: true,
      onionOnly: false
    })
  })

  it('reports an onion-only record in direct mode', () => {
    expect(selectTransportEndpoints([onion], false)).toEqual({
      candidates: [],
      onionAvailable: true,
      onionOnly: true
    })
  })

  it('loads direct endpoints normally when there is no onion', () => {
    expect(selectTransportEndpoints([direct], true)).toEqual({
      candidates: [direct],
      onionAvailable: false,
      onionOnly: false
    })
    expect(hasOnionEndpoint([direct])).toBe(false)
  })
})

describe('TransportPolicy', () => {
  it('honours the global preference and a per-service override', () => {
    let prefer = false
    const policy = new TransportPolicy(() => prefer)
    expect(policy.useTor('npub1a', 'web', true)).toBe(false)
    expect(policy.toggle('npub1a', 'web', true)).toBe(true)
    expect(policy.useTor('npub1a', 'web', true)).toBe(true)
    expect(policy.forcedTor('npub1a', 'web')).toBe(true)
    expect(policy.toggle('npub1a', 'web', true)).toBe(false)

    prefer = true
    expect(policy.useTor('npub1a', 'web', true)).toBe(true)
    expect(policy.useTor('npub1a', 'web', false)).toBe(false)
  })

  it('clears overrides when the preference changes', () => {
    const policy = new TransportPolicy(() => false)
    policy.toggle('npub1a', 'web', true)
    policy.clear()
    expect(policy.useTor('npub1a', 'web', true)).toBe(false)
  })
})

describe('TorGuard', () => {
  it('allows onion, ncc and inert local URLs', () => {
    expect(isAllowedTorUrl('ncc://npub1a/web/')).toBe(true)
    expect(isAllowedTorUrl('data:text/html,hi')).toBe(true)
    expect(isAllowedTorUrl('blob:https://x/1')).toBe(true)
    expect(isAllowedTorUrl('http://example.onion/')).toBe(true)
    expect(isAllowedTorUrl('https://example.onion/')).toBe(true)
    expect(isAllowedTorUrl('wss://example.onion/')).toBe(true)
  })

  it('blocks clearnet and local network resources', () => {
    expect(isAllowedTorUrl('http://127.0.0.1:8080/leak.png')).toBe(false)
    expect(isAllowedTorUrl('https://example.com/app.js')).toBe(false)
    expect(isAllowedTorUrl('wss://relay.example/')).toBe(false)
    expect(isAllowedTorUrl('file:///etc/passwd')).toBe(false)
  })

  it('matches only the onion suffix', () => {
    expect(isOnionHost('abc.onion')).toBe(true)
    expect(isOnionHost('onion')).toBe(true)
    expect(isOnionHost('abc.onion.example.com')).toBe(false)
  })

  it('allows only onion or ncc redirects from an onion endpoint', () => {
    const base = new URL('http://service.onion/page')
    expect(isAllowedTorRedirect('/next', base)).toBe(true)
    expect(isAllowedTorRedirect('http://other.onion/', base)).toBe(true)
    expect(isAllowedTorRedirect('ncc://npub1a/web/', base)).toBe(true)
    expect(isAllowedTorRedirect('https://example.com/', base)).toBe(false)
    expect(isAllowedTorRedirect('http://127.0.0.1:8080/', base)).toBe(false)
    expect(isAllowedTorRedirect('blob:http://service.onion/1', base)).toBe(false)
  })
})
