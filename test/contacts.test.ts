import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { ContactsStore } from '../src/main/contacts/store'
import { ContactsService } from '../src/main/contacts/service'
import type { ConfigStore } from '../src/main/config'

const NOW = 1_800_000_000_000

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-contacts-')), 'contacts.json')
}

function profileEvent(secret: Uint8Array, name: string): Event {
  return finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(NOW / 1000),
      tags: [],
      content: JSON.stringify({ name, display_name: `${name} Display`, nip05: `${name}@example.com` })
    },
    secret
  )
}

function kind3(secret: Uint8Array, pubkeys: string[]): Event {
  return finalizeEvent(
    {
      kind: 3,
      created_at: Math.floor(NOW / 1000),
      tags: pubkeys.map((pubkey) => ['p', pubkey]),
      content: ''
    },
    secret
  )
}

function setup() {
  const ownerSecret = generateSecretKey()
  const owner = getPublicKey(ownerSecret)
  const alice = generateSecretKey()
  const bob = generateSecretKey()
  const aliceProfile = profileEvent(alice, 'alice')
  const bobProfile = profileEvent(bob, 'bob')
  const list = kind3(ownerSecret, [getPublicKey(alice), getPublicKey(bob)])
  let now = NOW
  let queries = 0
  const query = async (_relays: string[], filter: { kinds?: number[]; authors?: string[] }) => {
    queries += 1
    if (filter.kinds?.includes(3)) return [list]
    if (filter.kinds?.includes(0)) {
      const authors = filter.authors ?? []
      return [aliceProfile, bobProfile].filter((event) => authors.includes(event.pubkey))
    }
    return []
  }
  const store = new ContactsStore(tempFile(), () => now)
  const changes: number[] = []
  const service = new ContactsService({
    store,
    relays: { query },
    config: { getRelays: () => ['wss://relay.test'] } as unknown as ConfigStore,
    owner: () => owner,
    now: () => now,
    onChange: (state) => changes.push(state.list?.contacts.length ?? 0)
  })
  return {
    service,
    store,
    owner,
    alice: getPublicKey(alice),
    bob: getPublicKey(bob),
    advance: (ms: number) => {
      now += ms
    },
    getQueries: () => queries
  }
}

describe('ContactsService', () => {
  it('fetches the newest kind 3 and labels contacts from kind 0', async () => {
    const { service, owner, alice, bob } = setup()
    const list = await service.refresh(owner)
    expect(list?.contacts).toHaveLength(2)
    expect(list?.contacts.find((contact) => contact.pubkey === alice)?.displayName).toBe(
      'alice Display'
    )
    expect(list?.contacts.find((contact) => contact.pubkey === bob)?.nip05).toBe('bob@example.com')
    expect(service.state().list?.stale).toBe(false)
  })

  it('serves the cache without a query until it is stale, then refreshes', async () => {
    const { service, owner, advance, getQueries } = setup()
    await service.refresh(owner)
    const afterFirst = getQueries()
    service.state()
    expect(getQueries()).toBe(afterFirst)

    advance(7 * 60 * 60_000)
    service.state()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getQueries()).toBeGreaterThan(afterFirst)
    expect(service.state().list?.stale).toBe(false)
  })

  it('keeps a cached list when no kind 3 event is returned', async () => {
    const { service, owner, store } = setup()
    await service.refresh(owner)
    const cached = store.get(owner)
    expect(cached?.contacts).toHaveLength(2)
    const emptyService = new ContactsService({
      store,
      relays: { query: async () => [] },
      config: { getRelays: () => ['wss://relay.test'] } as unknown as ConfigStore,
      owner: () => owner,
      now: () => NOW
    })
    const list = await emptyService.refresh(owner)
    expect(list?.contacts).toHaveLength(2)
  })

  it('returns null when there is no owner or no cached list', async () => {
    const { service } = setup()
    expect(service.state().owner).toBeTruthy()
    const anonymous = new ContactsService({
      store: new ContactsStore(tempFile(), () => NOW),
      relays: { query: async () => [] },
      config: { getRelays: () => [] } as unknown as ConfigStore,
      owner: () => null,
      now: () => NOW
    })
    expect(anonymous.state()).toMatchObject({ owner: null, list: null })
  })
})
