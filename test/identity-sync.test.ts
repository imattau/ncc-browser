import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
  type EventTemplate
} from 'nostr-tools'
import {
  IDENTITIES_D,
  mergeIdentityMarks,
  normalizeIdentityVault,
  planIdentitySync,
  sameIdentityVault
} from '../src/shared/sync'
import { BookmarkStore } from '../src/main/bookmarks'
import { HistoryStore } from '../src/main/history'
import { SyncPrefsStore } from '../src/main/sync/prefs'
import { SyncService } from '../src/main/sync/service'
import { testIdentity } from './helpers/identities'

const [A, B, C] = [testIdentity(11), testIdentity(12), testIdentity(13)]
const vault = (entries = [A, B, C], marks?: unknown) => ({ v: 1, updatedAt: 1, entries, ...(marks ? { marks } : {}) })
const empty = { excluded: [], marks: [] }
const keys = (list: Array<{ pubkey: string }>) => list.map((entry) => entry.pubkey).sort()
const only = (...list: Array<{ pubkey: string }>) => keys(list)

describe('the identity sync plan', () => {
  it('only ever adds when nothing has been removed', () => {
    expect(keys(planIdentitySync([A], vault(), empty, 2).imports)).toEqual(only(B, C))
    expect(keys(planIdentitySync([A, B, C], vault([A]), empty, 2).doc.entries)).toEqual(only(A, B, C))
  })

  it('does not import a key removed from this device, but leaves it synced', () => {
    const plan = planIdentitySync([A, B], vault(), { excluded: [C.pubkey], marks: [] }, 2)
    expect(plan.imports).toEqual([])
    expect(keys(plan.doc.entries)).toEqual(only(A, B, C))
  })

  it('forgets that exclusion once the person adds the key back', () => {
    const plan = planIdentitySync([C], vault([]), { excluded: [C.pubkey], marks: [] }, 2)
    expect(plan.unexclude).toEqual([C.pubkey])
  })

  it('takes a removed key out of the vault and asks, instead of deleting it', () => {
    const marks = [{ pubkey: C.pubkey, removed: true, at: 5 }]
    const holder = planIdentitySync([A, C], vault(), { excluded: [], marks }, 9)
    expect(keys(holder.doc.entries)).toEqual(only(A, B))
    expect(holder.removals).toEqual(marks)
    // A device without it never gets it.
    expect(keys(planIdentitySync([A], vault([A, B, C], marks), empty, 9).imports)).toEqual(only(B))
  })

  it('lets the newest choice win, and removal on a tie', () => {
    const removed = { pubkey: C.pubkey, removed: true, at: 5 }
    const restored = { pubkey: C.pubkey, removed: false, at: 6 }
    expect(mergeIdentityMarks([removed], [restored])).toEqual([restored])
    expect(mergeIdentityMarks([restored], [removed])).toEqual([restored])
    expect(mergeIdentityMarks([{ ...restored, at: 5 }], [removed])).toEqual([removed])
    const back = planIdentitySync([C], vault([A], [removed]), { excluded: [], marks: [restored] }, 9)
    expect(keys(back.doc.entries)).toEqual(only(A, C))
  })

  it('puts a removal back after an older version writes the vault without it', () => {
    const marks = [{ pubkey: C.pubkey, removed: true, at: 5 }]
    const plan = planIdentitySync([A], vault([A, B, C]), { excluded: [], marks }, 9)
    expect(plan.doc.marks).toEqual(marks)
    expect(keys(plan.doc.entries)).toEqual(only(A, B))
  })

  it('compares what vaults say, not when they were written', () => {
    const doc = normalizeIdentityVault(vault())
    expect(sameIdentityVault(doc, { ...doc, updatedAt: 99 })).toBe(true)
    expect(sameIdentityVault(doc, { ...doc, entries: doc.entries.slice(1) })).toBe(false)
  })

  it('refuses a malformed removal list', () => {
    for (const marks of [{}, [{ pubkey: 'x', removed: true, at: 1 }], [{ pubkey: A.pubkey, removed: 'yes', at: 1 }]]) {
      expect(() => normalizeIdentityVault(vault([A], marks))).toThrow(/removal/)
    }
  })
})

/** One relay, one shared default key, and as many devices as a test needs. */
function world() {
  const ownerKey = generateSecretKey()
  const owner = getPublicKey(ownerKey)
  const ownerEntry = { pubkey: owner, nsec: nip19.nsecEncode(ownerKey) }
  const events = new Map<string, Event>()
  let published = 0
  const clock = { now: 1_800_000_000_000 }
  const conversation = (pubkey: string) => nip44.v2.utils.getConversationKey(ownerKey, pubkey)
  const provider = {
    getPublicKey: async () => owner,
    signEvent: async (template: EventTemplate) => finalizeEvent(template, ownerKey),
    nip44Encrypt: async (pubkey: string, text: string) => nip44.v2.encrypt(text, conversation(pubkey)),
    nip44Decrypt: async (pubkey: string, text: string) => nip44.v2.decrypt(text, conversation(pubkey))
  }
  const pool = {
    query: async () => [...events.values()],
    queryAuth: async () => [...events.values()],
    publishWithAuth: async (_url: string, event: Event) => {
      const d = event.tags.find((tag) => tag[0] === 'd')![1]
      events.set(d, event)
      published += 1
      return 'ok'
    }
  }
  const relayVault = async () =>
    normalizeIdentityVault(JSON.parse(await provider.nip44Decrypt(owner, events.get(IDENTITIES_D)!.content)))

  async function device(...held: Array<{ pubkey: string; nsec: string }>) {
    const dir = mkdtempSync(join(tmpdir(), 'ncc-identity-sync-'))
    const prefs = new SyncPrefsStore(join(dir, 'sync.json'))
    const local = new Map([ownerEntry, ...held].map((entry) => [entry.pubkey, entry]))
    let defaultId = owner
    const service = new SyncService({
      prefs,
      identity: { provider: () => null },
      identityVault: {
        defaultId: () => defaultId,
        providerFor: (id) => (local.has(id) && id === owner ? provider : local.has(id) ? provider : null),
        entries: () => [...local.values()],
        importSecret: async (secret) => {
          const entry = [A, B, C, ownerEntry].find((known) => known.nsec === secret)!
          if (local.has(entry.pubkey)) return false
          local.set(entry.pubkey, entry)
          return true
        }
      },
      relays: pool,
      resolveRelays: async () => ['wss://relay.test'],
      bookmarks: new BookmarkStore(join(dir, 'bookmarks.json')),
      history: new HistoryStore(join(dir, 'history.json')),
      tabs: () => [],
      notify: () => undefined,
      platform: 'linux',
      now: () => clock.now
    })
    return {
      service,
      prefs,
      held: () => keys([...local.values()].filter((entry) => entry.pubkey !== owner)),
      enable: () => service.configure({ categories: { identities: true } }),
      sync: async () => {
        clock.now += 60_000
        const status = await service.syncNow()
        expect(status.error).toBeNull()
        return status
      },
      /** What the identity manager does when the person removes a key. */
      remove: (pubkey: string, scope: 'device' | 'everywhere') => {
        service.prepareIdentityRemoval(pubkey, scope)
        local.delete(pubkey)
      },
      add: (entry: { pubkey: string; nsec: string }) => local.set(entry.pubkey, entry),
      drop: (pubkey: string) => local.delete(pubkey),
      setDefault: (pubkey: string) => (defaultId = pubkey)
    }
  }
  return { device, owner, relayVault, publishes: () => published }
}

async function pair() {
  const w = world()
  const laptop = await w.device(A, B, C)
  const phone = await w.device()
  await laptop.enable()
  await phone.enable()
  return { w, laptop, phone }
}

describe('identity sync between devices', () => {
  it('adds keys, reports that the list changed, and stops publishing once agreed', async () => {
    const { w, laptop, phone } = await pair()
    expect(phone.held()).toEqual(only(A, B, C))
    expect(phone.service.status().identityRevision).toBe(3)
    const before = w.publishes()
    await laptop.sync()
    await phone.sync()
    await laptop.sync()
    expect(w.publishes()).toBe(before)
  })

  it('keeps a key off the device it was removed from', async () => {
    const { w, laptop, phone } = await pair()
    phone.remove(C.pubkey, 'device')
    await phone.sync()
    await phone.sync()
    expect(phone.held()).toEqual(only(A, B))
    await laptop.sync()
    expect(laptop.held()).toEqual(only(A, B, C))
    expect(keys((await w.relayVault()).entries)).toContain(C.pubkey)
  })

  it('stops syncing a key everywhere without deleting other copies', async () => {
    const { w, laptop, phone } = await pair()
    laptop.remove(C.pubkey, 'everywhere')
    await laptop.sync()
    const status = await phone.sync()
    await laptop.sync()
    expect(laptop.held()).toEqual(only(A, B))
    expect(phone.held()).toEqual(only(A, B, C))
    expect(keys((await w.relayVault()).entries)).not.toContain(C.pubkey)
    expect(status.identityRemovals).toEqual([
      { pubkey: C.pubkey, npub: nip19.npubEncode(C.pubkey), kept: false }
    ])
    // A new device on the same list never receives it.
    const tablet = await w.device()
    await tablet.enable()
    expect(tablet.held()).toEqual(only(A, B))
  })

  it('stops asking after Keep, and Sync again brings it back for everyone', async () => {
    const { w, laptop, phone } = await pair()
    laptop.remove(C.pubkey, 'everywhere')
    await laptop.sync()
    await phone.sync()
    expect((await phone.service.resolveIdentityRemoval(C.pubkey, 'keep')).identityRemovals?.[0].kept).toBe(true)
    await phone.sync()
    expect(keys((await w.relayVault()).entries)).not.toContain(C.pubkey)
    await phone.service.resolveIdentityRemoval(C.pubkey, 'restore')
    await phone.sync()
    expect(keys((await w.relayVault()).entries)).toContain(C.pubkey)
    expect(phone.service.status().identityRemovals).toBeUndefined()
    // It is synced again, but stays off the laptop it was removed from.
    await laptop.sync()
    expect(laptop.held()).toEqual(only(A, B))
  })

  it('guards the key that protects the list', async () => {
    const { w, laptop } = await pair()
    expect(() => laptop.service.prepareIdentityRemoval(w.owner, 'device')).toThrow(/protects your synced identity list/)
    expect(laptop.service.status().identityOwner).toBe(w.owner)
    await laptop.service.configure({ categories: { identities: false } })
    expect(() => laptop.service.prepareIdentityRemoval(A.pubkey, 'everywhere')).toThrow(/Turn on identity sync/)
    laptop.remove(w.owner, 'device')
    expect(laptop.prefs.get().identityVaultOwnerId).toBeUndefined()
  })

  it('offers a way on when the previous owner’s key is already gone', async () => {
    const { w, laptop } = await pair()
    laptop.drop(w.owner)
    laptop.setDefault(A.pubkey)
    expect(laptop.service.status()).toMatchObject({ identityMigrationFrom: w.owner, identityOwnerMissing: true })
    await laptop.service.resetIdentityOwner()
    expect(laptop.prefs.get().identityVaultOwnerId).toBe(A.pubkey)
    expect(laptop.service.status().identityMigrationFrom).toBeUndefined()
  })

  it('remembers removals across a restart', async () => {
    const { laptop } = await pair()
    laptop.remove(C.pubkey, 'everywhere')
    const file = (laptop.prefs as unknown as { filePath: string }).filePath
    const reread = new SyncPrefsStore(file).get()
    expect(reread.identityState.excluded).toEqual([C.pubkey])
    expect(reread.identityState.marks[0]).toMatchObject({ pubkey: C.pubkey, removed: true })
  })
})

describe('cases shared with the Android build', () => {
  interface SharedCase {
    name: string
    local: Array<{ pubkey: string; nsec: string }>
    remote: unknown
    state: Parameters<typeof planIdentitySync>[2]
    expect: unknown
  }
  const vectors = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/identity-sync-vectors.json'), 'utf8')
  ) as { cases: SharedCase[]; refused: Array<{ name: string; remote: unknown }> }
  const named = <T extends { name: string }>(list: T[]) => list.map((item) => [item.name, item] as const)

  it.each(named(vectors.cases))('%s', (_name, item) => {
    const plan = planIdentitySync(item.local, item.remote, item.state, 100)
    expect({
      entries: keys(plan.doc.entries),
      imports: keys(plan.imports),
      unexclude: plan.unexclude,
      removals: plan.removals.map((mark) => mark.pubkey),
      marks: plan.marks
    }).toEqual(item.expect)
  })

  it.each(named(vectors.refused))('refuses %s', (_name, item) => {
    expect(() => planIdentitySync([], item.remote, empty, 100)).toThrow()
  })
})
