import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools'
import { NsiteResolver } from '../src/main/nsite/resolver'
import { NSITE_NAMED_KIND, NSITE_ROOT_KIND } from '../src/main/nsite/manifest'

const SK = generateSecretKey()
const PUB = getPublicKey(SK)
const HASH = createHash('sha256').update('a').digest('hex')

function event(kind: number, tags: string[][], createdAt: number): Event {
  return finalizeEvent({ kind, created_at: createdAt, tags, content: '' }, SK) as Event
}

const rootEvent = (createdAt: number, title: string) =>
  event(NSITE_ROOT_KIND, [['path', '/index.html', HASH], ['title', title]], createdAt)

describe('NsiteResolver', () => {
  it('returns the newest root manifest', async () => {
    const now = 1_800_000_000
    const resolver = new NsiteResolver({
      relays: () => ['wss://relay.example'],
      now: () => now,
      query: async () => [rootEvent(now - 10, 'old'), rootEvent(now - 1, 'new')]
    })

    const outcome = await resolver.resolve(PUB, null)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.manifest.title).toBe('new')
  })

  it('filters named sites by d tag', async () => {
    const now = 1_800_000_000
    const resolver = new NsiteResolver({
      relays: () => ['wss://relay.example'],
      now: () => now,
      query: async (_relays, filter) => {
        expect(filter['#d']).toEqual(['blog'])
        return [event(NSITE_NAMED_KIND, [['d', 'blog'], ['path', '/index.html', HASH]], now)]
      }
    })
    const outcome = await resolver.resolve(PUB, 'blog')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.manifest.site).toBe('blog')
  })

  it('accepts an npub as well as hex', async () => {
    const resolver = new NsiteResolver({
      relays: () => ['wss://relay.example'],
      now: () => 1_800_000_000,
      query: async (_relays, filter) => {
        expect(filter.authors).toEqual([PUB])
        return [rootEvent(1_799_999_999, 'npub key')]
      }
    })
    const outcome = await resolver.resolve(nip19.npubEncode(PUB), null)
    expect(outcome.ok).toBe(true)
  })

  it('reports a missing manifest', async () => {
    const resolver = new NsiteResolver({
      relays: () => ['wss://relay.example'],
      query: async () => [],
      now: () => 1_800_000_000
    })
    await expect(resolver.resolve(PUB, null)).resolves.toMatchObject({
      ok: false,
      code: 'no-manifest'
    })
  })

  it('caches a manifest and serves it stale while refreshing', async () => {
    let now = 1_800_000_000
    let calls = 0
    const resolver = new NsiteResolver({
      relays: () => ['wss://relay.example'],
      now: () => now,
      ttlSeconds: 10,
      query: async () => {
        calls += 1
        return [rootEvent(now - 1, `v${calls}`)]
      }
    })

    const first = await resolver.resolve(PUB, null)
    expect(first.ok && first.manifest.title).toBe('v1')

    now += 5
    const cached = await resolver.resolve(PUB, null)
    expect(cached.ok && cached.manifest.title).toBe('v1')
    expect(calls).toBe(1)

    now += 30
    const stale = await resolver.resolve(PUB, null)
    expect(stale.ok && stale.stale).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  })

  it('surfaces a timeout', async () => {
    const resolver = new NsiteResolver({
      relays: () => ['wss://relay.example'],
      timeoutMs: 5,
      query: () => new Promise(() => undefined),
      now: () => 1_800_000_000
    })
    await expect(resolver.resolve(PUB, null)).resolves.toMatchObject({ ok: false, code: 'timeout' })
  })
})
