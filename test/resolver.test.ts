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
    expect(filter.kinds).toEqual([30058])
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
})
