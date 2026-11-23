import { describe, expect, it, vi } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
  type Filter
} from 'nostr-tools'
import { NccResolver, signerFromSecret, toHexPubkey } from '../src/main/ncc/resolver'
import type { QueryFn } from '../src/main/ncc/resolver'
import type { ResolvedService } from '../src/shared/types'

const NOW = 1_800_000_000
const AUTHOR_SK = generateSecretKey()
const AUTHOR_PK = getPublicKey(AUTHOR_SK)
const NPUB = nip19.npubEncode(AUTHOR_PK)
const OTHER_SK = generateSecretKey()
const OTHER_PK = getPublicKey(OTHER_SK)

interface EventOptions {
  d?: string
  payload?: unknown
  createdAt?: number
  secretKey?: Uint8Array
  encryptTo?: string | null
  content?: string
  expiration?: number
  tags?: string[][]
}

function locatorEvent(options: EventOptions = {}): Event {
  const payload = options.payload ?? {
    v: 1,
    ttl: 600,
    updated_at: NOW,
    endpoints: [{ type: 'http', uri: '127.0.0.1:8080', priority: 1, family: 'ipv4' }]
  }

  let content: string
  if (options.content !== undefined) {
    content = options.content
  } else if (options.encryptTo) {
    const conversationKey = nip44.getConversationKey(options.secretKey ?? AUTHOR_SK, options.encryptTo)
    content = nip44.encrypt(JSON.stringify(payload), conversationKey)
  } else {
    content = JSON.stringify(payload)
  }

  const tags: string[][] = [['d', options.d ?? 'addr']]
  if (options.expiration) tags.push(['expiration', String(options.expiration)])
  if (options.tags) tags.push(...options.tags)

  return finalizeEvent(
    {
      kind: 30058,
      created_at: options.createdAt ?? NOW - 10,
      tags,
      content
    },
    options.secretKey ?? AUTHOR_SK
  )
}

function relayListEvent(tags: string[][], createdAt = NOW - 5): Event {
  return finalizeEvent({ kind: 10002, created_at: createdAt, tags, content: '' }, AUTHOR_SK)
}

interface AnchorOptions {
  d?: string
  u?: string | null
  k?: string | null
  exp?: number | null
  createdAt?: number
  secretKey?: Uint8Array
}

function anchorEvent(options: AnchorOptions = {}): Event {
  const tags: string[][] = [['d', options.d ?? 'addr']]
  if (options.u) tags.push(['u', options.u])
  if (options.k) tags.push(['k', options.k])
  if (options.exp !== null) tags.push(['exp', String(options.exp ?? NOW + 600)])
  return finalizeEvent(
    {
      kind: 30059,
      created_at: options.createdAt ?? NOW - 10,
      tags,
      content: ''
    },
    options.secretKey ?? AUTHOR_SK
  )
}

function memoryStore() {
  const map = new Map<string, { record: ResolvedService; validatedAt: number }>()
  return {
    map,
    get: (hex: string, service: string) => map.get(`${hex}:${service}`) ?? null,
    set: (record: ResolvedService, validatedAt = NOW) => {
      map.set(`${record.hexPubkey}:${record.service}`, { record, validatedAt })
    },
    delete: (hex: string, service: string) => {
      map.delete(`${hex}:${service}`)
    }
  }
}

function resolverWith(events: Event[] | QueryFn, overrides: Partial<ConstructorParameters<typeof NccResolver>[0]> = {}) {
  const query =
    typeof events === 'function'
      ? events
      : vi.fn<QueryFn>(async (_relays: string[], _filter: Filter) => events)
  const resolver = new NccResolver({
    relays: () => ['wss://relay.test'],
    query,
    now: () => NOW,
    timeoutMs: 50,
    ...overrides
  })
  return { resolver, query }
}

describe('toHexPubkey', () => {
  it('decodes npub and accepts hex', () => {
    expect(toHexPubkey(NPUB)).toBe(AUTHOR_PK)
    expect(toHexPubkey(AUTHOR_PK.toUpperCase())).toBe(AUTHOR_PK)
    expect(toHexPubkey('npub1nope')).toBeNull()
    expect(toHexPubkey('example.com')).toBeNull()
  })
})

describe('NccResolver', () => {
  it('resolves a public locator', async () => {
    const { resolver, query } = resolverWith([locatorEvent()])
    const outcome = await resolver.resolve(NPUB)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.dTag).toBe('addr')
    expect(outcome.record.endpoints[0].url).toBe('http://127.0.0.1:8080/')
    expect(outcome.record.expiresAt).toBe(NOW + 600)
    expect(outcome.record.encrypted).toBe(false)

    const filter = (query as ReturnType<typeof vi.fn>).mock.calls[0][1] as Filter
    expect(filter.kinds).toEqual([30058, 30059])
    expect(filter.authors).toEqual([AUTHOR_PK])
    expect(filter['#d']).toEqual(['addr'])
  })

  it('falls back from service to <service>-locator', async () => {
    const { resolver } = resolverWith([
      locatorEvent({
        d: 'web-locator',
        payload: {
          ttl: 600,
          updated_at: NOW,
          endpoints: [{ type: 'https', uri: '10.0.0.5:443', priority: 1 }]
        }
      })
    ])
    const outcome = await resolver.resolve(NPUB, 'web')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.dTag).toBe('web-locator')
    expect(outcome.record.dTagSource).toBe('locator-suffix')
  })

  it('does not lose an older service when another service was updated later', async () => {
    // This is the ncc-05-js bug: it keeps only the author's freshest event, then
    // rejects it because the d tag does not match.
    const { resolver } = resolverWith([
      locatorEvent({ d: 'api', createdAt: NOW - 1 }),
      locatorEvent({ d: 'web', createdAt: NOW - 500 })
    ])
    const outcome = await resolver.resolve(NPUB, 'web')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.dTag).toBe('web')
  })

  it('skips an undecryptable newest event and uses the next one', async () => {
    const { resolver } = resolverWith([
      locatorEvent({ createdAt: NOW - 1, encryptTo: OTHER_PK }),
      locatorEvent({ createdAt: NOW - 20 })
    ])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.encrypted).toBe(false)
  })

  it('decrypts a record addressed to the configured signer', async () => {
    const readerSk = generateSecretKey()
    const readerPk = getPublicKey(readerSk)
    const { resolver } = resolverWith([locatorEvent({ encryptTo: readerPk })], {
      signer: signerFromSecret(readerSk)
    })
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.encrypted).toBe(true)
  })

  it('decrypts through a signer that only exposes decrypt44 (NIP-46)', async () => {
    const readerSk = generateSecretKey()
    const readerPk = getPublicKey(readerSk)
    const decrypt44 = vi.fn(async (peer: string, ciphertext: string) =>
      nip44.decrypt(ciphertext, nip44.getConversationKey(readerSk, peer))
    )
    const { resolver } = resolverWith([locatorEvent({ encryptTo: readerPk })], {
      signer: { decrypt44 }
    })
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    expect(decrypt44).toHaveBeenCalledTimes(1)
  })

  it('decrypts a multi-recipient wrapped locator', async () => {
    const readerSk = generateSecretKey()
    const otherSk = generateSecretKey()
    const readerPk = getPublicKey(readerSk)
    const otherPk = getPublicKey(otherSk)
    const sessionKey = generateSecretKey()
    const sessionHex = Array.from(sessionKey)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const payload = {
      ttl: 600,
      updated_at: NOW,
      endpoints: [{ type: 'https', uri: '10.0.0.9:8443', priority: 1 }]
    }
    const ciphertext = nip44.encrypt(
      JSON.stringify(payload),
      nip44.getConversationKey(sessionKey, getPublicKey(sessionKey))
    )
    const wraps = {
      [readerPk]: nip44.encrypt(sessionHex, nip44.getConversationKey(readerSk, AUTHOR_PK)),
      [otherPk]: nip44.encrypt(sessionHex, nip44.getConversationKey(otherSk, AUTHOR_PK))
    }
    const wrapped = locatorEvent({
      tags: [['private', 'true']],
      content: JSON.stringify({ ciphertext, wraps })
    })

    const { resolver } = resolverWith([wrapped], { signer: signerFromSecret(readerSk) })
    const outcome = await resolver.resolve(NPUB)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.encrypted).toBe(true)
    expect(outcome.record.endpoints[0].url).toBe('https://10.0.0.9:8443/')
  })

  it('reports a wrapped locator as undecryptable for an unknown recipient', async () => {
    const readerSk = generateSecretKey()
    const outsiderSk = generateSecretKey()
    const sessionKey = generateSecretKey()
    const sessionHex = Array.from(sessionKey)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const ciphertext = nip44.encrypt(
      JSON.stringify({ ttl: 600, updated_at: NOW, endpoints: [{ uri: '10.0.0.9:8443' }] }),
      nip44.getConversationKey(sessionKey, getPublicKey(sessionKey))
    )
    const wrapped = locatorEvent({
      tags: [['private', 'true']],
      content: JSON.stringify({
        ciphertext,
        wraps: {
          [getPublicKey(readerSk)]: nip44.encrypt(
            sessionHex,
            nip44.getConversationKey(readerSk, AUTHOR_PK)
          )
        }
      })
    })

    const { resolver } = resolverWith([wrapped], { signer: signerFromSecret(outsiderSk) })
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('undecryptable')
  })

  it('reports undecryptable when no signer is configured', async () => {
    const { resolver } = resolverWith([locatorEvent({ encryptTo: OTHER_PK })])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('undecryptable')
  })

  it('prefers the newest event and breaks ties by event id', async () => {
    const older = locatorEvent({
      createdAt: NOW - 100,
      payload: { ttl: 600, updated_at: NOW, endpoints: [{ uri: '9.9.9.9:80' }] }
    })
    const tieA = locatorEvent({
      createdAt: NOW - 5,
      payload: { ttl: 600, updated_at: NOW, endpoints: [{ uri: '1.1.1.1:80' }] }
    })
    const tieB = locatorEvent({
      createdAt: NOW - 5,
      payload: { ttl: 600, updated_at: NOW, endpoints: [{ uri: '2.2.2.2:80' }] }
    })
    const expected = tieA.id < tieB.id ? tieA : tieB

    const { resolver } = resolverWith([older, tieB, tieA])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.eventId).toBe(expected.id)
  })

  it('refuses an expired record', async () => {
    const { resolver } = resolverWith([
      locatorEvent({
        payload: { ttl: 60, updated_at: NOW - 120, endpoints: [{ uri: '1.2.3.4:80' }] }
      })
    ])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('expired')
  })

  it('honours the expiration tag over the payload ttl', async () => {
    const { resolver } = resolverWith([locatorEvent({ expiration: NOW - 1 })])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('expired')
  })

  it('reports no-record when nothing matches', async () => {
    const { resolver } = resolverWith([])
    const outcome = await resolver.resolve(NPUB, 'web')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-record')
  })

  it('ignores events from another author and invalid signatures', async () => {
    const impostor = locatorEvent({ secretKey: OTHER_SK })
    // Round-trip through JSON: nostr-tools caches verification on the object itself,
    // and events off the wire never carry that cache.
    const tampered = {
      ...JSON.parse(JSON.stringify(locatorEvent())),
      content: '{"ttl":600,"updated_at":1,"endpoints":[]}'
    } as Event
    const { resolver } = resolverWith([impostor, tampered as Event])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-record')
  })

  it('reports no-endpoint for ws-only records', async () => {
    const { resolver } = resolverWith([
      locatorEvent({
        payload: { ttl: 600, updated_at: NOW, endpoints: [{ type: 'wss', uri: 'wss://relay.test' }] }
      })
    ])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-endpoint')
  })

  it('reports relay failures and timeouts distinctly', async () => {
    const relayError = resolverWith(async () => {
      throw new Error('socket closed')
    }).resolver
    const failed = await relayError.resolve(NPUB)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('relay-error')

    const slow = resolverWith(() => new Promise<Event[]>(() => {})).resolver
    const timedOut = await slow.resolve(NPUB)
    expect(timedOut.ok).toBe(false)
    if (!timedOut.ok) expect(timedOut.code).toBe('timeout')
  })

  it('caches positive results', async () => {
    const { resolver, query } = resolverWith([locatorEvent()])
    await resolver.resolve(NPUB)
    await resolver.resolve(NPUB)
    expect((query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('deduplicates in-flight resolutions', async () => {
    const query = vi.fn<QueryFn>(
      () =>
        new Promise<Event[]>((resolve) => {
          setTimeout(() => resolve([locatorEvent()]), 5)
        })
    )
    const resolver = new NccResolver({
      relays: () => ['wss://relay.test'],
      query,
      now: () => NOW
    })
    await Promise.all([resolver.resolve(NPUB), resolver.resolve(NPUB), resolver.resolve(NPUB)])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid pubkey before querying', async () => {
    const { resolver, query } = resolverWith([locatorEvent()])
    const outcome = await resolver.resolve('nope')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('invalid-address')
    expect(query).not.toHaveBeenCalled()
  })

  it('follows NIP-65 relay hints when gossip is enabled', async () => {
    const calls: Array<{ relays: string[]; filter: Filter }> = []
    const query: QueryFn = async (relays, filter) => {
      calls.push({ relays, filter })
      if (filter.kinds?.includes(10002)) {
        return [relayListEvent([['r', 'wss://hint.example'], ['r', 'wss://write.example', 'write']])]
      }
      return relays.includes('wss://hint.example') ? [locatorEvent()] : []
    }

    const resolver = new NccResolver({
      relays: () => ['wss://primary.example'],
      query,
      now: () => NOW,
      gossip: () => true
    })

    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)

    const locatorCall = calls.find((call) => call.filter.kinds?.includes(30058))
    expect(locatorCall?.relays).toContain('wss://primary.example')
    expect(locatorCall?.relays).toContain('wss://hint.example')
    expect(locatorCall?.relays).not.toContain('wss://write.example')
  })

  it('does not ask for a relay list when gossip is disabled', async () => {
    const query = vi.fn<QueryFn>(async (_relays, filter) =>
      filter.kinds?.includes(10002) ? [] : [locatorEvent()]
    )
    const resolver = new NccResolver({
      relays: () => ['wss://primary.example'],
      query,
      now: () => NOW,
      gossip: () => false
    })
    await resolver.resolve(NPUB)
    expect(query.mock.calls.some((call) => call[1].kinds?.includes(10002))).toBe(false)
  })

  it('resolves anyway when the gossip lookup fails', async () => {
    const query: QueryFn = async (_relays, filter) => {
      if (filter.kinds?.includes(10002)) throw new Error('hint relay down')
      return [locatorEvent()]
    }
    const resolver = new NccResolver({
      relays: () => ['wss://primary.example'],
      query,
      now: () => NOW,
      gossip: () => true
    })
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
  })

  it('reads public records from the persistent store without querying', async () => {
    const store = memoryStore()
    const first = resolverWith([locatorEvent()], { cacheStore: store }).resolver
    const initial = await first.resolve(NPUB)
    expect(initial.ok).toBe(true)
    expect(store.map.size).toBe(1)

    const query = vi.fn<QueryFn>(async () => {
      throw new Error('should not query relays')
    })
    const second = new NccResolver({
      relays: () => ['wss://relay.test'],
      query,
      now: () => NOW,
      cacheStore: store
    })
    const outcome = await second.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!initial.ok || !outcome.ok) return
    expect(outcome.record.eventId).toBe(initial.record.eventId)
    expect(query).not.toHaveBeenCalled()
  })

  it('revalidates a persisted record once it is older than the window', async () => {
    const store = memoryStore()
    const rotated = locatorEvent({
      createdAt: NOW + 10,
      payload: { ttl: 600, updated_at: NOW, endpoints: [{ uri: '10.0.0.9:9090' }] }
    })
    const query = vi.fn<QueryFn>(async () => [rotated])
    const resolver = new NccResolver({
      relays: () => ['wss://relay.test'],
      query,
      now: () => NOW,
      cacheStore: store,
      revalidateSeconds: 30
    })

    store.set(
      {
        pubkey: NPUB,
        hexPubkey: AUTHOR_PK,
        service: 'addr',
        dTag: 'addr',
        dTagSource: 'exact',
        endpoints: [
          { url: 'http://10.0.0.1:8080/', protocol: 'http', priority: 1, family: 'ipv4', k: null }
        ],
        expiresAt: NOW + 600,
        updatedAt: NOW - 300,
        eventId: 'old-event',
        encrypted: false
      },
      NOW - 120
    )

    const stale = await resolver.resolve(NPUB)
    expect(stale.ok).toBe(true)
    if (!stale.ok) return
    expect(stale.record.eventId).toBe('old-event')
    expect(stale.record.stale).toBe(true)

    // The cached endpoint is served immediately; the query runs behind it.
    await resolver.settle()
    expect(query).toHaveBeenCalledTimes(1)
    expect(store.map.get(`${AUTHOR_PK}:addr`)?.record.eventId).toBe(rotated.id)

    const fresh = await resolver.resolve(NPUB)
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(fresh.record.endpoints[0].url).toBe('http://10.0.0.9:9090/')
    expect(fresh.record.stale).toBeUndefined()
  })

  it('serves a persisted record without a query while it is still fresh', async () => {
    const store = memoryStore()
    const query = vi.fn<QueryFn>(async () => {
      throw new Error('should not query relays')
    })
    store.set(
      {
        pubkey: NPUB,
        hexPubkey: AUTHOR_PK,
        service: 'addr',
        dTag: 'addr',
        dTagSource: 'exact',
        endpoints: [
          { url: 'http://10.0.0.1:8080/', protocol: 'http', priority: 1, family: 'ipv4', k: null }
        ],
        expiresAt: NOW + 600,
        updatedAt: NOW,
        eventId: 'fresh-event',
        encrypted: false
      },
      NOW - 5
    )

    const resolver = new NccResolver({
      relays: () => ['wss://relay.test'],
      query,
      now: () => NOW,
      cacheStore: store,
      revalidateSeconds: 60
    })
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.eventId).toBe('fresh-event')
    expect(outcome.record.stale).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it('keeps the cached record when a background revalidation fails', async () => {
    const store = memoryStore()
    const query = vi.fn<QueryFn>(async () => {
      throw new Error('relay down')
    })
    store.set(
      {
        pubkey: NPUB,
        hexPubkey: AUTHOR_PK,
        service: 'addr',
        dTag: 'addr',
        dTagSource: 'exact',
        endpoints: [
          { url: 'http://10.0.0.1:8080/', protocol: 'http', priority: 1, family: 'ipv4', k: null }
        ],
        expiresAt: NOW + 600,
        updatedAt: NOW,
        eventId: 'cached-event',
        encrypted: false
      },
      NOW - 300
    )

    const resolver = new NccResolver({
      relays: () => ['wss://relay.test'],
      query,
      now: () => NOW,
      cacheStore: store,
      revalidateSeconds: 30
    })
    const first = await resolver.resolve(NPUB)
    await resolver.settle()
    const second = await resolver.resolve(NPUB)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.record.eventId).toBe('cached-event')
    expect(second.record.stale).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('does not trust a persisted anchor whose exp has passed', async () => {
    const store = memoryStore()
    const anchor = anchorEvent({ d: 'addr', exp: NOW - 1 })
    const query = vi.fn<QueryFn>(async () => [anchor])
    store.set(
      {
        pubkey: NPUB,
        hexPubkey: AUTHOR_PK,
        service: 'addr',
        dTag: 'addr',
        dTagSource: 'exact',
        endpoints: [
          { url: 'http://10.0.0.1:8080/', protocol: 'http', priority: 1, family: 'ipv4', k: null }
        ],
        expiresAt: NOW + 600,
        updatedAt: NOW,
        eventId: 'stale-anchor-event',
        encrypted: false,
        anchor: {
          status: 'anchored',
          record: {
            eventId: anchor.id,
            dTag: 'addr',
            endpoint: null,
            rawEndpoint: null,
            k: null,
            expiresAt: NOW - 1,
            updatedAt: NOW - 100
          },
          fallback: false,
          kMatch: 'none',
          required: true
        }
      },
      NOW
    )

    const resolver = new NccResolver({
      relays: () => ['wss://relay.test'],
      query,
      now: () => NOW,
      cacheStore: store,
      anchorRequired: () => true
    })
    const outcome = await resolver.resolve(NPUB)
    expect(query).toHaveBeenCalledTimes(1)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('anchor-expired')
  })

  it('caps a synthesised NCC-02 fallback to a short lifetime', async () => {
    const anchor = anchorEvent({ d: 'web', u: 'http://10.0.0.9:8080', exp: NOW + 14 * 86_400 })
    const store = memoryStore()
    const resolver = resolverWith([anchor], { cacheStore: store, fallbackSeconds: 120 }).resolver
    const outcome = await resolver.resolve(NPUB, 'web')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.expiresAt).toBe(NOW + 120)
    expect(store.map.get(`${AUTHOR_PK}:web`)?.record.expiresAt).toBe(NOW + 120)
  })

  it('invalidate drops both cache layers', async () => {
    const store = memoryStore()
    const { resolver, query } = resolverWith([locatorEvent()], { cacheStore: store })

    await resolver.resolve(NPUB)
    expect(store.map.size).toBe(1)

    resolver.invalidate(NPUB, 'addr')
    expect(store.map.size).toBe(0)

    await resolver.resolve(NPUB)
    expect((query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('never persists an encrypted record', async () => {
    const readerSk = generateSecretKey()
    const store = memoryStore()
    const resolver = resolverWith([locatorEvent({ encryptTo: getPublicKey(readerSk) })], {
      signer: signerFromSecret(readerSk),
      cacheStore: store
    }).resolver
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    expect(store.map.size).toBe(0)
  })

  it('attaches an NCC-02 anchor and applies its transport key', async () => {
    const anchor = anchorEvent({
      d: 'addr',
      u: 'https://127.0.0.1:8443',
      k: 'ANCHOR-KEY'
    })
    const locator = locatorEvent({
      payload: {
        ttl: 600,
        updated_at: NOW,
        endpoints: [{ type: 'https', uri: '127.0.0.1:8443' }]
      }
    })
    const { resolver } = resolverWith([locator, anchor])
    const outcome = await resolver.resolve(NPUB)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.anchor?.status).toBe('anchored')
    expect(outcome.record.anchor?.record?.eventId).toBe(anchor.id)
    expect(outcome.record.anchor?.fallback).toBe(false)
    expect(outcome.record.anchor?.kMatch).toBe('anchor-only')
    expect(outcome.record.endpoints[0].k).toBe('ANCHOR-KEY')
    expect(outcome.record.endpoints[0].kSource).toBe('ncc-02')
  })

  it('treats a matching NCC-05 key and NCC-02 key as anchored', async () => {
    const anchor = anchorEvent({ d: 'addr', u: 'https://127.0.0.1:8443', k: 'SAME' })
    const locator = locatorEvent({
      payload: {
        ttl: 600,
        updated_at: NOW,
        endpoints: [{ type: 'https', uri: '127.0.0.1:8443', k: 'SAME' }]
      }
    })
    const { resolver } = resolverWith([locator, anchor])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.anchor?.kMatch).toBe('match')
    expect(outcome.record.endpoints[0].kSource).toBe('ncc-05')
  })

  it('falls back to the NCC-02 u endpoint when NCC-05 is missing', async () => {
    const anchor = anchorEvent({ d: 'web', u: 'http://10.0.0.9:8080', k: null })
    const { resolver } = resolverWith([anchor])
    const outcome = await resolver.resolve(NPUB, 'web')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.eventId).toBe(anchor.id)
    expect(outcome.record.dTag).toBe('web')
    expect(outcome.record.endpoints[0].url).toBe('http://10.0.0.9:8080/')
    expect(outcome.record.anchor?.fallback).toBe(true)
  })

  it('requires an anchor when anchored mode is on', async () => {
    const { resolver } = resolverWith([locatorEvent()], { anchorRequired: () => true })
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-anchor')
  })

  it('reports an expired anchor distinctly in anchored mode', async () => {
    const { resolver } = resolverWith(
      [locatorEvent(), anchorEvent({ exp: NOW - 1 })],
      { anchorRequired: () => true }
    )
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('anchor-expired')
  })

  it('fails closed when NCC-02 and NCC-05 pin different keys for one origin', async () => {
    const anchor = anchorEvent({ d: 'addr', u: 'https://127.0.0.1:8443', k: 'ANCHOR' })
    const locator = locatorEvent({
      payload: {
        ttl: 600,
        updated_at: NOW,
        endpoints: [{ type: 'https', uri: '127.0.0.1:8443', k: 'LOCATOR' }]
      }
    })
    const { resolver } = resolverWith([locator, anchor])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('anchor-k-mismatch')
  })

  it('does not apply an anchor key to a different origin', async () => {
    const anchor = anchorEvent({ d: 'addr', u: 'https://other.example:8443', k: 'ANCHOR' })
    const { resolver } = resolverWith([locatorEvent(), anchor])
    const outcome = await resolver.resolve(NPUB)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.anchor?.kMatch).toBe('none')
    expect(outcome.record.endpoints[0].k).toBeNull()
  })
})
