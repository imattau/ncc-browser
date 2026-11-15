import { describe, expect, it, vi } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type Event,
  type Filter
} from 'nostr-tools'
import { normalizeRelayEntries, parseRelayLocator } from '../src/shared/relays'
import {
  normalizeEndpoints,
  selectRelayEndpoint
} from '../src/main/ncc/locator'
import { NccResolver, type QueryFn } from '../src/main/ncc/resolver'
import { RelayLocatorService } from '../src/main/relay/locator'
import type { ResolvedEndpoint } from '../src/shared/types'

const NOW = 1_800_000_000
const AUTHOR_SK = generateSecretKey()
const AUTHOR_PK = getPublicKey(AUTHOR_SK)
const NPUB = nip19.npubEncode(AUTHOR_PK)

function endpoint(overrides: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint {
  return {
    url: 'wss://relay.example/',
    protocol: 'wss',
    priority: 1000,
    family: 'unknown',
    k: null,
    ...overrides
  }
}

function relayLocatorEvent(payload: unknown, d = 'relay'): Event {
  return finalizeEvent(
    { kind: 30058, created_at: NOW - 10, tags: [['d', d]], content: JSON.stringify(payload) },
    AUTHOR_SK
  )
}

function relayResolver(events: Event[]) {
  const query = vi.fn<QueryFn>(async (_relays: string[], _filter: Filter) => events)
  const resolver = new NccResolver({
    relays: () => ['wss://relay.test'],
    query,
    now: () => NOW,
    timeoutMs: 50
  })
  return resolver
}

describe('parseRelayLocator', () => {
  it('parses an npub and service', () => {
    expect(parseRelayLocator(`ncc://${NPUB}/relay`)).toEqual({
      identity: NPUB,
      pubkey: AUTHOR_PK,
      service: 'relay',
      uri: `ncc://${NPUB}/relay`
    })
  })

  it('defaults a bare identity to the relay service', () => {
    expect(parseRelayLocator(`ncc://${NPUB}`)?.service).toBe('relay')
    expect(parseRelayLocator(`ncc://${NPUB}`)?.uri).toBe(`ncc://${NPUB}/relay`)
  })

  it('accepts hex and trims a trailing slash', () => {
    expect(parseRelayLocator(`ncc://${AUTHOR_PK.toUpperCase()}/relay/`)?.pubkey).toBe(AUTHOR_PK)
  })

  it('rejects anything that is not an NCC identity', () => {
    expect(parseRelayLocator('wss://relay.example')).toBeNull()
    expect(parseRelayLocator('ncc://npub1notvalid/relay')).toBeNull()
    expect(parseRelayLocator('ncc://example.com/relay')).toBeNull()
    expect(parseRelayLocator(`ncc://${NPUB}/relay/extra`)).toBeNull()
  })
})

describe('normalizeRelayEntries', () => {
  it('accepts the legacy string list', () => {
    expect(normalizeRelayEntries(['wss://relay.example/', 'ws://127.0.0.1:7777'])).toEqual([
      { url: 'wss://relay.example' },
      { url: 'ws://127.0.0.1:7777' }
    ])
  })

  it('keeps locator metadata and drops a malformed locator', () => {
    const expiresAt = NOW + 600
    const entries = normalizeRelayEntries([
      {
        url: 'wss://relay.example',
        locator: {
          identity: NPUB,
          pubkey: AUTHOR_PK,
          service: 'relay',
          dTag: 'relay',
          expiresAt,
          k: 'abc'
        }
      },
      { url: 'wss://broken.example', locator: { pubkey: 'nope' } }
    ])

    expect(entries[0].locator).toMatchObject({ pubkey: AUTHOR_PK, expiresAt, k: 'abc' })
    expect(entries[1]).toEqual({ url: 'wss://broken.example' })
  })

  it('deduplicates by URL and rejects empty lists', () => {
    expect(normalizeRelayEntries(['wss://a.example', 'wss://a.example'])).toEqual([
      { url: 'wss://a.example' }
    ])
    expect(() => normalizeRelayEntries([])).toThrow(/At least one relay/)
  })
})

describe('relay endpoints', () => {
  it('normalises ws endpoints only when asked', () => {
    const payload = [
      { url: 'wss://relay.example', priority: 1 },
      { url: 'https://relay.example', priority: 2 }
    ]
    expect(normalizeEndpoints(payload).map((entry) => entry.protocol)).toEqual(['https'])
    expect(normalizeEndpoints(payload, { allowWs: true }).map((entry) => entry.protocol)).toEqual([
      'wss',
      'https'
    ])
  })

  it('prefers wss over a higher-priority cleartext endpoint', () => {
    const selection = selectRelayEndpoint(
      [
        endpoint({ url: 'ws://relay.example/', protocol: 'ws', priority: 1, family: 'ipv4' }),
        endpoint({ url: 'wss://relay.example/', priority: 2, family: 'ipv4' })
      ],
      { torReady: false }
    )
    expect(selection.endpoint?.url).toBe('wss://relay.example/')
  })

  it('allows cleartext ws only on loopback', () => {
    const loopback = selectRelayEndpoint(
      [endpoint({ url: 'ws://127.0.0.1:7777/', protocol: 'ws', family: 'ipv4' })],
      { torReady: false }
    )
    expect(loopback.endpoint?.url).toBe('ws://127.0.0.1:7777/')

    const publicHost = selectRelayEndpoint(
      [endpoint({ url: 'ws://relay.example/', protocol: 'ws', family: 'unknown' })],
      { torReady: false }
    )
    expect(publicHost.endpoint).toBeNull()
    expect(publicHost.rejected).toBe('insecure-endpoint')
  })

  it('skips onion endpoints without Tor and reports why', () => {
    const onion = endpoint({
      url: 'ws://abc.onion/',
      protocol: 'ws',
      family: 'onion'
    })
    expect(selectRelayEndpoint([onion], { torReady: false }).rejected).toBe('onion-requires-tor')
    expect(selectRelayEndpoint([onion], { torReady: true }).endpoint?.url).toBe('ws://abc.onion/')
  })
})

describe('RelayLocatorService', () => {
  const payload = {
    v: 1,
    ttl: 600,
    updated_at: NOW,
    endpoints: [
      {
        url: 'wss://relay.example',
        priority: 1,
        family: 'ipv4',
        k: 'cGlu'
      }
    ]
  }

  function service(events: Event[], torReady = true) {
    return new RelayLocatorService({
      resolver: relayResolver(events),
      entries: () => [{ url: 'wss://bootstrap.test' }],
      torReady: () => torReady,
      now: () => NOW
    })
  }

  it('resolves an ncc:// relay to a pinned wss endpoint', async () => {
    const outcome = await service([relayLocatorEvent(payload)]).resolve(`ncc://${NPUB}/relay`)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.entry.url).toBe('wss://relay.example/')
    expect(outcome.entry.locator).toMatchObject({
      identity: NPUB,
      pubkey: AUTHOR_PK,
      service: 'relay',
      dTag: 'relay',
      expiresAt: NOW + 600,
      k: 'cGlu'
    })
  })

  it('reports no-endpoint for a page-style locator without ws endpoints', async () => {
    const outcome = await service([
      relayLocatorEvent({
        ...payload,
        endpoints: [{ url: 'https://relay.example', priority: 1 }]
      })
    ]).resolve(`ncc://${NPUB}/relay`)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-endpoint')
  })

  it('keeps web resolution free of ws endpoints', async () => {
    const resolver = relayResolver([relayLocatorEvent(payload)])
    const outcome = await resolver.resolve(NPUB, 'relay')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-endpoint')
  })

  it('refuses onion-only relays when Tor is not ready', async () => {
    const outcome = await service(
      [
        relayLocatorEvent({
          ...payload,
          endpoints: [{ url: 'ws://abc.onion', priority: 1, family: 'onion' }]
        })
      ],
      false
    ).resolve(`ncc://${NPUB}/relay`)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('onion-requires-tor')
  })

  it('falls back to built-in relays when the list has none left', async () => {
    const locator = new RelayLocatorService({
      resolver: relayResolver([]),
      entries: () => [],
      torReady: () => false
    })
    expect(locator.lookupRelays()).toContain('wss://relay.damus.io')
  })
})
