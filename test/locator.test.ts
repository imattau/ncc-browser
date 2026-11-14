import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRIORITY,
  candidateDTags,
  dTagSource,
  normalizeEndpoints,
  payloadExpiry,
  parsePayload,
  sortEndpoints
} from '../src/main/ncc/locator'

describe('candidateDTags', () => {
  it('probes exact, then sidecar suffix, then default', () => {
    expect(candidateDTags('web')).toEqual(['web', 'web-locator', 'addr'])
  })

  it('uses only addr when no service is addressed', () => {
    expect(candidateDTags()).toEqual(['addr'])
    expect(candidateDTags('')).toEqual(['addr'])
    expect(candidateDTags('addr')).toEqual(['addr'])
  })

  it('classifies which candidate matched', () => {
    expect(dTagSource('web', 'web')).toBe('exact')
    expect(dTagSource('web-locator', 'web')).toBe('locator-suffix')
    expect(dTagSource('addr', 'web')).toBe('default')
  })
})

describe('parsePayload', () => {
  const valid = { ttl: 600, updated_at: 1_700_000_000, endpoints: [{ uri: '1.2.3.4:80' }] }

  it('accepts a valid payload and coerces numbers', () => {
    expect(parsePayload({ ...valid, ttl: '600' })?.ttl).toBe(600)
  })

  it('rejects missing or invalid fields', () => {
    expect(parsePayload(null)).toBeNull()
    expect(parsePayload({ ...valid, endpoints: undefined })).toBeNull()
    expect(parsePayload({ ...valid, ttl: 0 })).toBeNull()
    expect(parsePayload({ ...valid, ttl: -1 })).toBeNull()
    expect(parsePayload({ ...valid, updated_at: 'soon' })).toBeNull()
  })
})

describe('payloadExpiry', () => {
  const payload = { ttl: 600, updated_at: 1_000, endpoints: [] }

  it('falls back to updated_at + ttl', () => {
    expect(payloadExpiry(payload)).toBe(1_600)
  })

  it('uses the earliest of expiration tag and ttl', () => {
    expect(payloadExpiry(payload, '1500')).toBe(1_500)
    expect(payloadExpiry(payload, '9999')).toBe(1_600)
    expect(payloadExpiry(payload, 'not-a-number')).toBe(1_600)
  })
})

describe('normalizeEndpoints', () => {
  it('accepts both url and uri', () => {
    const endpoints = normalizeEndpoints([
      { url: 'https://one.example:8443', priority: 1 },
      { uri: 'http://two.example:8080', priority: 2 }
    ])
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual([
      'https://one.example:8443/',
      'http://two.example:8080/'
    ])
  })

  it('gives scheme-less endpoints a scheme from type/protocol', () => {
    const [https, http] = normalizeEndpoints([
      { type: 'https', uri: '192.168.1.42:443' },
      { protocol: 'http', uri: '192.168.1.42:8080' }
    ])
    expect(https.url).toBe('https://192.168.1.42/')
    expect(https.protocol).toBe('https')
    expect(http.url).toBe('http://192.168.1.42:8080/')
  })

  it('maps tcp/tls aliases to fetchable schemes', () => {
    const [tcp, tls] = normalizeEndpoints([
      { type: 'tcp', uri: '10.0.0.1:80' },
      { type: 'tls', uri: '10.0.0.2:443' }
    ])
    expect(tcp.protocol).toBe('http')
    expect(tls.protocol).toBe('https')
  })

  it('drops transports that cannot carry a page', () => {
    expect(
      normalizeEndpoints([
        { type: 'wss', uri: 'wss://relay.example' },
        { type: 'onion', uri: 'abc.onion:80' },
        { type: 'http', uri: '1.2.3.4:80' }
      ])
    ).toHaveLength(1)
  })

  it('handles IPv6 literals', () => {
    const [endpoint] = normalizeEndpoints([{ type: 'http', uri: '[2001:db8::1]:8080' }])
    expect(endpoint.url).toBe('http://[2001:db8::1]:8080/')
    expect(endpoint.family).toBe('ipv6')
  })

  it('defaults priority to 1000, not 0', () => {
    const [endpoint] = normalizeEndpoints([{ uri: '1.2.3.4:80' }])
    expect(endpoint.priority).toBe(DEFAULT_PRIORITY)
  })

  it('deduplicates identical endpoints and ignores junk', () => {
    const endpoints = normalizeEndpoints([
      { uri: '1.2.3.4:80' },
      { url: 'http://1.2.3.4:80/' },
      null,
      'nope',
      { uri: '' }
    ])
    expect(endpoints).toHaveLength(1)
  })

  it('keeps the k fingerprint', () => {
    const [endpoint] = normalizeEndpoints([{ uri: '1.2.3.4:443', type: 'https', k: 'abc' }])
    expect(endpoint.k).toBe('abc')
  })
})

describe('sortEndpoints', () => {
  it('orders by priority then family', () => {
    const endpoints = normalizeEndpoints([
      { uri: '4.4.4.4:80', priority: 10 },
      { uri: '[2001:db8::1]:80', priority: 10 },
      { uri: '1.1.1.1:80', priority: 5 }
    ])
    expect(sortEndpoints(endpoints).map((endpoint) => endpoint.family)).toEqual([
      'ipv4',
      'ipv6',
      'ipv4'
    ])
    expect(sortEndpoints(endpoints)[0].url).toContain('1.1.1.1')
  })
})
