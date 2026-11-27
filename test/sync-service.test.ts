import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  nip19,
  type Event,
  type EventTemplate,
  type Filter
} from 'nostr-tools'
import { BookmarkStore } from '../src/main/bookmarks'
import { HistoryStore } from '../src/main/history'
import { SyncPrefsStore } from '../src/main/sync/prefs'
import { SyncService } from '../src/main/sync/service'
import type { SyncStatus } from '../src/shared/sync-status'
import type { SyncTab } from '../src/shared/sync'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const key = nip44.getConversationKey(sk, pk)

const provider = {
  getPublicKey: async () => pk,
  signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
  nip44Encrypt: async (_peer: string, plaintext: string) => nip44.encrypt(plaintext, key),
  nip44Decrypt: async (_peer: string, ciphertext: string) => nip44.decrypt(ciphertext, key)
}

function makeProvider(secret: Uint8Array) {
  const pubkey = getPublicKey(secret)
  const conversationKey = nip44.getConversationKey(secret, pubkey)
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (template: EventTemplate) => finalizeEvent(template, secret),
    nip44Encrypt: async (_peer: string, plaintext: string) => nip44.encrypt(plaintext, conversationKey),
    nip44Decrypt: async (_peer: string, ciphertext: string) => nip44.decrypt(ciphertext, conversationKey)
  }
}

/** One in-memory relay shared by every "device", replacing events by `d` like a relay does. */
function relay() {
  const store = new Map<string, Event>()
  const published: string[] = []
  const query = async (_relays: string[], filter: Filter): Promise<Event[]> =>
    [...store.values()].filter(
      (event) =>
        event.kind === filter.kinds?.[0] &&
        event.tags.some((tag) => tag[0] === 't' && tag[1] === filter['#t']?.[0])
    )
  return {
    store,
    published,
    pool: {
      query,
      queryAuth: query,
      publishWithAuth: async (_url: string, event: Event): Promise<string> => {
        const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''
        const current = store.get(d)
        if (!current || current.created_at <= event.created_at) store.set(d, event)
        published.push(d)
        return 'ok'
      }
    }
  }
}

function device(
  shared: ReturnType<typeof relay>,
  name: string,
  platform: string,
  clock: { now: number },
  tabs: SyncTab[] = []
) {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-sync-'))
  const bookmarks = new BookmarkStore(join(dir, 'bookmarks.json'), () => clock.now)
  const history = new HistoryStore(join(dir, 'history.json'), () => clock.now)
  const prefs = new SyncPrefsStore(join(dir, 'sync.json'))
  const statuses: SyncStatus[] = []
  const service = new SyncService({
    prefs,
    identity: { provider: () => provider },
    relays: shared.pool,
    resolveRelays: async () => ['wss://relay.test'],
    bookmarks,
    history,
    tabs: () => tabs,
    notify: (status) => statuses.push(status),
    platform,
    now: () => clock.now
  })
  prefs.update({ deviceName: name })
  return { bookmarks, history, prefs, service, statuses }
}

const all = { bookmarks: true, tabs: true, history: true }

describe('SyncService', () => {
  it('migrates the identity vault only on request and retains the previous encrypted copy', async () => {
    const clock = { now: 1_800_000_000_000 }
    const oldProvider = makeProvider(generateSecretKey())
    const newProvider = makeProvider(generateSecretKey())
    const syncedKey = generateSecretKey()
    const syncedPubkey = getPublicKey(syncedKey)
    const syncedNsec = nip19.nsecEncode(syncedKey)
    const events = new Map<string, Event>()
    const pool = {
      query: async (_relays: string[], filter: Filter) => [...events.values()].filter((event) =>
        event.kind === filter.kinds?.[0] && event.pubkey === filter.authors?.[0] &&
        event.tags.some((tag) => tag[0] === 't' && tag[1] === filter['#t']?.[0])),
      queryAuth: async (_relays: string[], filter: Filter) => [...events.values()].filter((event) =>
        event.kind === filter.kinds?.[0] && event.pubkey === filter.authors?.[0] &&
        event.tags.some((tag) => tag[0] === 't' && tag[1] === filter['#t']?.[0])),
      publishWithAuth: async (_url: string, event: Event) => {
        const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''
        events.set(`${event.pubkey}:${d}`, event)
        return 'ok'
      }
    }
    const oldPubkey = await oldProvider.getPublicKey()
    const newPubkey = await newProvider.getPublicKey()
    const oldEvent = await oldProvider.signEvent({
      kind: 30078, created_at: 10, tags: [['d', 'ncc-browser/identities/v1'], ['t', 'ncc-browser/sync']],
      content: await oldProvider.nip44Encrypt(oldPubkey, JSON.stringify({ v: 1, updatedAt: 1, entries: [{ pubkey: syncedPubkey, nsec: syncedNsec }] }))
    })
    events.set(`${oldPubkey}:ncc-browser/identities/v1`, oldEvent)
    const dir = mkdtempSync(join(tmpdir(), 'ncc-sync-migration-'))
    const prefs = new SyncPrefsStore(join(dir, 'sync.json'))
    prefs.update({ categories: { identities: true } })
    prefs.setIdentityVaultOwner(oldPubkey)
    const imported: string[] = []
    const vault = {
      defaultId: () => newPubkey,
      providerFor: (id: string) => id === oldPubkey ? oldProvider : id === newPubkey ? newProvider : null,
      entries: () => [],
      importSecret: async (secret: string) => { imported.push(secret); return true }
    }
    const service = new SyncService({
      prefs, identity: { provider: () => newProvider }, identityVault: vault, relays: pool,
      resolveRelays: async () => ['wss://relay.test'], bookmarks: new BookmarkStore(join(dir, 'bookmarks.json')),
      history: new HistoryStore(join(dir, 'history.json')), tabs: () => [], notify: () => undefined,
      platform: 'linux', now: () => clock.now
    })

    expect(service.status().identityMigrationFrom).toBe(oldPubkey)
    await service.migrateIdentities()

    expect(service.status().identityMigrationFrom).toBeUndefined()
    expect(prefs.get().identityVaultOwnerId).toBe(newPubkey)
    expect(imported).toContain(syncedNsec)
    expect(events.has(`${oldPubkey}:ncc-browser/identities/v1`)).toBe(true)
    expect(events.has(`${newPubkey}:ncc-browser/identities/v1`)).toBe(true)
  })

  it('syncs local identities only when the identity category is enabled', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const identityKey = generateSecretKey()
    const secondPubkey = getPublicKey(identityKey)
    const identityNsec = nip19.nsecEncode(identityKey)
    const a = device(shared, 'Laptop', 'linux', clock)
    const b = device(shared, 'Phone', 'android', clock)
    const localA = [
      { pubkey: pk, nsec: nip19.nsecEncode(sk) },
      { pubkey: secondPubkey, nsec: identityNsec }
    ]
    const localB: Array<{ pubkey: string; nsec: string }> = []
    const makeVault = (entries: Array<{ pubkey: string; nsec: string }>) => ({
      defaultId: () => pk,
      providerFor: () => provider,
      entries: () => [...entries],
      importSecret: async (secret: string) => {
        if (secret === identityNsec && !entries.some((entry) => entry.pubkey === secondPubkey)) {
          entries.push({ pubkey: secondPubkey, nsec: secret })
          return true
        }
        return false
      }
    })
    const aService = new SyncService({
      prefs: a.prefs, identity: { provider: () => null }, identityVault: makeVault(localA),
      relays: shared.pool, resolveRelays: async () => ['wss://relay.test'], bookmarks: a.bookmarks,
      history: a.history, tabs: () => [], notify: () => undefined, platform: 'linux', now: () => clock.now
    })
    const bService = new SyncService({
      prefs: b.prefs, identity: { provider: () => null }, identityVault: makeVault(localB),
      relays: shared.pool, resolveRelays: async () => ['wss://relay.test'], bookmarks: b.bookmarks,
      history: b.history, tabs: () => [], notify: () => undefined, platform: 'android', now: () => clock.now
    })
    a.prefs.update({ categories: { identities: true } })
    b.prefs.update({ categories: { identities: true } })
    await aService.syncNow()
    await bService.syncNow()
    expect(localB).toEqual([{ pubkey: secondPubkey, nsec: identityNsec }])
    expect(shared.published).toContain('ncc-browser/identities/v1')
  })

  describe('identity sync when not every relay answers', () => {
    const IDENTITIES = 'ncc-browser/identities/v1'
    const now = 1_800_000_000_000
    const ownerNsec = nip19.nsecEncode(sk)

    function identity() {
      const secret = generateSecretKey()
      return { pubkey: getPublicKey(secret), nsec: nip19.nsecEncode(secret) }
    }

    async function copy(createdAt: number, entries: Array<{ pubkey: string; nsec: string }>, marks?: unknown[]) {
      return finalizeEvent(
        {
          kind: 30078,
          created_at: createdAt,
          tags: [['d', IDENTITIES], ['t', 'ncc-browser/sync']],
          content: await provider.nip44Encrypt(pk, JSON.stringify({ v: 1, updatedAt: 1, entries, ...(marks ? { marks } : {}) }))
        },
        sk
      )
    }

    function setup(events: Event[], answered: number, asked: number, held: Array<{ pubkey: string; nsec: string }> = []) {
      const entries = [{ pubkey: pk, nsec: ownerNsec }, ...held]
      const published: Event[] = []
      const dir = mkdtempSync(join(tmpdir(), 'ncc-sync-partial-'))
      const prefs = new SyncPrefsStore(join(dir, 'sync.json'))
      prefs.update({ categories: { identities: true } })
      const report = async () => ({
        events,
        answered,
        asked,
        unanswered: Array.from({ length: asked - answered }, (_, index) => `wss://down-${index}.test`)
      })
      const service = new SyncService({
        prefs,
        identity: { provider: () => provider },
        identityVault: {
          defaultId: () => pk,
          providerFor: () => provider,
          entries: () => [...entries],
          importSecret: async (secret: string) => {
            const decoded = nip19.decode(secret)
            if (decoded.type !== 'nsec') return false
            entries.push({ pubkey: getPublicKey(decoded.data), nsec: secret })
            return true
          }
        },
        relays: {
          query: async () => events,
          queryAuth: async () => events,
          queryAuthReport: report,
          publishWithAuth: async (_url: string, event: Event) => {
            published.push(event)
            return 'ok'
          }
        },
        resolveRelays: async () => Array.from({ length: asked }, (_, index) => `wss://relay-${index}.test`),
        bookmarks: new BookmarkStore(join(dir, 'b.json')),
        history: new HistoryStore(join(dir, 'h.json')),
        tabs: () => [],
        notify: () => undefined,
        platform: 'linux',
        now: () => now
      })
      const sent = async () =>
        Promise.all(published.map(async (event) => JSON.parse(await provider.nip44Decrypt(pk, event.content))))
      return { service, entries, published, sent }
    }

    it('syncs from a copy even when only one relay answers', async () => {
      const other = identity()
      const mine = identity()
      const a = setup([await copy(10, [other])], 1, 5, [mine])
      const status = await a.service.syncNow()
      expect(status.error).toBeNull()
      expect(status.lastSyncedAt).toBe(now)
      expect(a.entries.map((entry) => entry.pubkey)).toContain(other.pubkey)
      const [doc] = await a.sent()
      expect(doc.entries.map((entry: { pubkey: string }) => entry.pubkey).sort()).toEqual(
        [pk, other.pubkey, mine.pubkey].sort()
      )
    })

    it('recovers keys that only an older copy has, and keeps removals', async () => {
      const lost = identity()
      const removed = identity()
      const newer = await copy(20, [], [{ pubkey: removed.pubkey, removed: true, at: 5 }])
      const older = await copy(10, [lost, removed])
      const a = setup([older, newer], 3, 3)
      await a.service.syncNow()
      expect(a.entries.map((entry) => entry.pubkey).sort()).toEqual([pk, lost.pubkey].sort())
      const [doc] = await a.sent()
      expect(doc.entries.map((entry: { pubkey: string }) => entry.pubkey).sort()).toEqual([pk, lost.pubkey].sort())
      expect(doc.marks).toHaveLength(1)
      expect(a.published[0].created_at).toBeGreaterThan(20)
    })

    it('writes the first list when at least half the relays say there is none', async () => {
      const a = setup([], 1, 2, [identity()])
      expect((await a.service.syncNow()).error).toBeNull()
      expect(a.published.length).toBeGreaterThan(0)
    })

    it('does not write a list with nothing to add while a relay is silent', async () => {
      const a = setup([], 2, 3)
      expect((await a.service.syncNow()).error).toBeNull()
      expect(a.published).toEqual([])
    })

    it('stops, naming the relays, when too few answer and none has a copy', async () => {
      const a = setup([], 1, 3, [identity()])
      const status = await a.service.syncNow()
      expect(status.error).toContain('1 of 3 relays answered')
      expect(status.error).toContain('wss://down-0.test')
      expect(a.published).toEqual([])
    })
  })

  it('does nothing until a category is switched on', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock)
    a.bookmarks.add('https://a.example/', 'A')
    await a.service.syncNow()
    expect(shared.published).toEqual([])
  })

  it('shares bookmarks, history and tabs between two devices', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock, [
      { url: 'https://tab.example/', title: 'A tab', lastActive: clock.now }
    ])
    const b = device(shared, 'Phone', 'android', clock)

    a.bookmarks.add('https://a.example/', 'A')
    a.history.record('https://visited.example/', 'Visited')
    await a.service.configure({ categories: all })
    expect(shared.published.some((d) => d.includes('bookmarks'))).toBe(true)
    expect(shared.published.some((d) => d.includes('history'))).toBe(true)
    expect(shared.published.some((d) => d.includes('tabs'))).toBe(true)

    // The relay only ever holds ciphertext.
    for (const event of shared.store.values()) {
      expect(event.content).not.toContain('a.example')
      expect(event.content).not.toContain('visited.example')
    }

    await b.service.configure({ categories: all })
    expect(b.bookmarks.list().map((entry) => entry.url)).toEqual(['https://a.example/'])
    expect(b.history.list().map((entry) => entry.url)).toEqual(['https://visited.example/'])
    const devices = b.service.status().devices
    expect(devices.map((entry) => entry.name)).toEqual(['Laptop'])
    expect(devices[0]?.tabs).toEqual([{ url: 'https://tab.example/', title: 'A tab' }])
  })

  it('carries a bookmark removal and a history clear to the other device', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock)
    const b = device(shared, 'Phone', 'android', clock)
    a.bookmarks.add('https://a.example/', 'A')
    a.history.record('https://visited.example/', 'Visited')
    await a.service.configure({ categories: all })
    await b.service.configure({ categories: all })
    expect(b.bookmarks.list()).toHaveLength(1)

    clock.now += 60_000
    b.bookmarks.remove('https://a.example/')
    b.history.clear()
    await b.service.syncNow()

    clock.now += 60_000
    await a.service.syncNow()
    expect(a.bookmarks.list()).toEqual([])
    expect(a.history.list()).toEqual([])
  })

  it('does not publish again when nothing changed', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock)
    a.bookmarks.add('https://a.example/', 'A')
    await a.service.configure({ categories: { bookmarks: true } })
    const count = shared.published.length
    clock.now += 60_000
    await a.service.syncNow()
    expect(shared.published.length).toBe(count)
  })

  it('never publishes a category that is off', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock)
    a.history.record('https://visited.example/', 'Visited')
    a.bookmarks.add('https://a.example/', 'A')
    await a.service.configure({ categories: { bookmarks: true } })
    expect(shared.published.every((d) => d.includes('bookmarks'))).toBe(true)
  })

  it('ignores a forged event signed by someone else', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock)
    const other = generateSecretKey()
    const forged = finalizeEvent(
      {
        kind: 30078,
        created_at: 2_000_000_000,
        tags: [
          ['d', 'ncc-browser/bookmarks/v1'],
          ['t', 'ncc-browser/sync']
        ],
        content: 'junk'
      },
      other
    )
    shared.store.set('ncc-browser/bookmarks/v1', forged)
    a.bookmarks.add('https://a.example/', 'A')
    await a.service.configure({ categories: { bookmarks: true } })
    expect(a.service.status().error).toBeNull()
    expect(a.bookmarks.list()).toHaveLength(1)
  })

  it('reports an unreachable relay instead of calling the data synced', async () => {
    const shared = relay()
    const clock = { now: 1_800_000_000_000 }
    const a = device(shared, 'Laptop', 'linux', clock)
    const dead = {
      ...shared.pool,
      queryAuthReport: async () => ({ events: [] as Event[], answered: 0 })
    }
    const dir = mkdtempSync(join(tmpdir(), 'ncc-sync-dead-'))
    const bookmarks = new BookmarkStore(join(dir, 'b.json'), () => clock.now)
    bookmarks.add('https://a.example/', 'A')
    const prefs = new SyncPrefsStore(join(dir, 's.json'))
    const service = new SyncService({
      prefs,
      identity: { provider: () => provider },
      relays: dead,
      resolveRelays: async () => ['wss://relay.test'],
      bookmarks,
      history: new HistoryStore(join(dir, 'h.json'), () => clock.now),
      tabs: () => [],
      notify: () => {},
      platform: 'linux',
      now: () => clock.now
    })
    const status = await service.configure({ categories: { bookmarks: true } })
    expect(status.error).toMatch(/No relay answered/)
    expect(status.lastSyncedAt).toBeNull()
    expect(shared.published).toEqual([])
    expect(a.bookmarks.list()).toEqual([])
  })
})
