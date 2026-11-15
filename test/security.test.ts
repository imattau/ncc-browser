import { describe, expect, it } from 'vitest'
import type { ResolvedEndpoint } from '../src/shared/types'
import {
  isHttpExemptUrl,
  isLoopbackHost,
  nccEndpointNeedsWarning,
  shouldUpgradeHttp,
  upgradeToHttps
} from '../src/main/security'
import { sortCandidatesForHttps } from '../src/main/ncc/transport'

function endpoint(url: string): ResolvedEndpoint {
  return {
    url,
    protocol: url.startsWith('https') ? 'https' : 'http',
    priority: 1,
    family: url.includes('.onion') ? 'onion' : 'ipv4',
    k: null
  }
}

describe('HTTPS policy', () => {
  it('identifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.9.8.7')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })

  it('upgrades only non-exempt clearnet HTTP URLs', () => {
    expect(shouldUpgradeHttp('http://example.com/a', 'prefer')).toBe(true)
    expect(shouldUpgradeHttp('http://example.com/a', 'only')).toBe(true)
    expect(shouldUpgradeHttp('http://example.com/a', 'off')).toBe(false)
    expect(shouldUpgradeHttp('https://example.com/a', 'prefer')).toBe(false)
    expect(shouldUpgradeHttp('http://127.0.0.1:8080/', 'prefer')).toBe(false)
    expect(shouldUpgradeHttp('http://abc.onion/', 'prefer')).toBe(false)
    expect(isHttpExemptUrl('http://localhost:5173/')).toBe(true)
  })

  it('keeps the port and drops the default HTTP port', () => {
    expect(upgradeToHttps('http://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(upgradeToHttps('http://example.com:8080/a')).toBe('https://example.com:8080/a')
    expect(upgradeToHttps('http://example.com:80/a')).toBe('https://example.com/a')
  })

  it('never warns for loopback or onion NCC endpoints', () => {
    expect(nccEndpointNeedsWarning(endpoint('http://127.0.0.1:8080/'))).toBe(false)
    expect(nccEndpointNeedsWarning(endpoint('http://abc.onion/'))).toBe(false)
    expect(nccEndpointNeedsWarning(endpoint('http://example.com/'))).toBe(true)
    expect(nccEndpointNeedsWarning(endpoint('https://example.com/'))).toBe(false)
  })

  it('puts published HTTPS endpoints first when HTTPS is preferred', () => {
    const http = endpoint('http://example.com:8080/')
    const https = endpoint('https://example.com:8443/')
    expect(sortCandidatesForHttps([http, https], 'prefer')).toEqual([https, http])
    expect(sortCandidatesForHttps([http, https], 'off')).toEqual([http, https])
  })
})
