import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { createMediaCache, legacyMediaKeys } from '../extensions/white-noise-prototype/media-cache.js'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { coalesce } from '../extensions/white-noise-prototype/refresh-queue.js'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { createLiveRelays, resumeFilters } from '../extensions/white-noise-prototype/relay-live.js'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { ExtensionStore, packStoredValue, restoreStoredValue } from '../extensions/white-noise-prototype/extension-store.js'

// @ts-expect-error The extension is plain JavaScript without type declarations.
import { createOrReuseDirectChat, findDirectChat } from '../extensions/white-noise-prototype/direct-chat.js'

// @ts-expect-error The extension is plain JavaScript without type declarations.
import { selectUsableKeyPackage } from '../extensions/white-noise-prototype/key-package-selection.js'

// @ts-expect-error The extension is plain JavaScript without type declarations.
import { planGroupRelayUpdates } from '../extensions/white-noise-prototype/group-relay-updates.js'

// @ts-expect-error The extension is plain JavaScript without type declarations.
import { watchGroups } from '../extensions/white-noise-prototype/group-watch.js'

// @ts-expect-error The extension is plain JavaScript without type declarations.
import { createReactionRumor, reactionContent, summarizeReactions } from '../extensions/white-noise-prototype/message-reactions.js'

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }))
afterEach(() => vi.useRealTimers())

describe('Marmot group watcher', () => {
  it('forwards reactive group snapshots and aborts its iterator on cleanup', async () => {
    let options: { includeStateChanges?: boolean; signal?: AbortSignal } | undefined
    const snapshots = [[{ id: 'first' }], [{ id: 'second' }]]
    const groups = {
      async *watch(received: typeof options) {
        options = received
        yield* snapshots
      }
    }
    const onChange = vi.fn()
    const stop = watchGroups(groups, onChange)

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2))
    expect(options?.includeStateChanges).toBe(true)
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(snapshots)
    stop()
    expect(options?.signal?.aborted).toBe(true)
  })

  it('reports watcher failures but ignores failures after cleanup', async () => {
    const failure = new Error('watch failed')
    const groups = { watch: async function* () { throw failure } }
    const onError = vi.fn()
    watchGroups(groups, vi.fn(), onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))

    const pending = {
      watch: async function* ({ signal }: { signal?: AbortSignal }) {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(failure), { once: true })
        })
        yield []
      }
    }
    const ignoredError = vi.fn()
    const stop = watchGroups(pending, vi.fn(), ignoredError)
    await Promise.resolve()
    stop()
    await Promise.resolve()
    expect(ignoredError).not.toHaveBeenCalled()
  })
})

describe('Marmot chat reactions', () => {
  it('aggregates reactions for the target message and deduplicates each author', () => {
    const history = [
      { id: 'r1', kind: 7, pubkey: 'alice', content: '❤️', tags: [['e', 'message-1']] },
      { id: 'r2', kind: 7, pubkey: 'alice', content: '❤️', tags: [['e', 'message-1']] },
      { id: 'r3', kind: 7, pubkey: 'bob', content: '+', tags: [['e', 'message-1']] },
      { id: 'r4', kind: 7, pubkey: 'carol', content: '😂', tags: [['e', 'message-2']] },
      { id: 'r5', kind: 9, pubkey: 'bob', content: 'not a reaction', tags: [['e', 'message-1']] }
    ]
    expect(summarizeReactions(history, 'message-1', 'alice')).toEqual([
      { emoji: '❤️', count: 1, reacted: true },
      { emoji: '👍', count: 1, reacted: false }
    ])
    expect(reactionContent('')).toBe('👍')
    expect(reactionContent('-')).toBe('👎')
  })

  it('builds a kind-7 reaction with target author and kind references', () => {
    const reaction = createReactionRumor({
      pubkey: 'a'.repeat(64),
      target: { id: 'b'.repeat(64), pubkey: 'c'.repeat(64), kind: 9 },
      emoji: '🎉',
      createdAt: 123
    })
    expect(reaction).toMatchObject({
      pubkey: 'a'.repeat(64), created_at: 123, kind: 7, content: '🎉',
      tags: [['e', 'b'.repeat(64), '', 'c'.repeat(64)], ['p', 'c'.repeat(64)], ['k', '9']]
    })
    expect(() => createReactionRumor({ pubkey: 'a', target: {}, emoji: '🎉' })).toThrow(/invalid/i)
  })
})

describe('Marmot extension storage', () => {
  function memoryStorage() {
    const values: Record<string, unknown> = {}
    return {
      values,
      async get(key: string | null) {
        if (key === null) return structuredClone(values)
        return { [key]: structuredClone(values[key]) }
      },
      async set(items: Record<string, unknown>) { Object.assign(values, structuredClone(items)) },
      async remove(key: string | string[]) {
        for (const item of Array.isArray(key) ? key : [key]) delete values[item]
      }
    }
  }

  it('round-trips MLS binary and collection values through storage-safe data', () => {
    const input = {
      epoch: 42n,
      tree: new Uint8Array([0, 1, 127, 255]),
      data: new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 2),
      members: new Set(['alice', 'bob']),
      secrets: new Map([[new Uint8Array([4, 5]), new Map([['generation', 6n]])]])
    }

    const packed = packStoredValue(input)
    expect(JSON.stringify(packed)).toBeTruthy()
    const restored = restoreStoredValue(packed) as {
      epoch: bigint
      tree: Uint8Array
      data: Uint8Array
      members: Set<string>
      secrets: Map<Uint8Array, Map<string, bigint>>
    }
    expect(restored.epoch).toBe(42n)
    expect(restored.tree).toEqual(new Uint8Array([0, 1, 127, 255]))
    expect(restored.data).toEqual(new Uint8Array([8, 7]))
    expect(restored.members).toEqual(new Set(['alice', 'bob']))
    expect([...restored.secrets].map(([key, value]) => [[...key], [...value]])).toEqual([
      [[4, 5], [['generation', 6n]]]
    ])
  })

  it('isolates account stores and clears only the selected namespace', async () => {
    const storage = memoryStorage()
    const alice = new ExtensionStore('account:alice:groups', storage)
    const bob = new ExtensionStore('account:bob:groups', storage)
    await alice.setItem('group-1', { epoch: 3n, tree: new Uint8Array([1, 2]) })
    await bob.setItem('group-2', { epoch: 9n, tree: new Uint8Array([8, 9]) })

    expect(await alice.keys()).toEqual(['group-1'])
    expect(await alice.getItem('group-1')).toEqual({ epoch: 3n, tree: new Uint8Array([1, 2]) })
    expect(await alice.getItem('group-2')).toBeNull()
    expect([...await bob.entries()].map(([key]) => key)).toEqual(['group-2'])

    await alice.clear()
    expect(await alice.keys()).toEqual([])
    expect(await bob.getItem('group-2')).toEqual({ epoch: 9n, tree: new Uint8Array([8, 9]) })
  })
})

describe('attachment cache', () => {
  const entry = (bytes: number, name: string): object => ({
    data: new Uint8Array(bytes),
    attachment: { filename: name }
  })

  it('stays within its limit by dropping the least recently used file', async () => {
    const cache = createMediaCache(100)
    const store = cache.storeFor('group')
    await store.addMedia('a', entry(40, 'a'))
    await store.addMedia('b', entry(40, 'b'))
    await store.getMedia('a')
    await store.addMedia('c', entry(40, 'c'))
    expect(await store.getMedia('b')).toBeNull()
    expect(await store.listMedia()).toEqual([{ filename: 'a' }, { filename: 'c' }])
    expect(cache.size).toBe(80)
    await store.addMedia('huge', entry(101, 'huge'))
    expect(await store.getMedia('huge')).toBeNull()
  })

  it('clears one group without touching another', async () => {
    const cache = createMediaCache(100)
    await cache.storeFor('g1').addMedia('a', entry(10, 'a'))
    await cache.storeFor('g2').addMedia('a', entry(10, 'a'))
    await cache.storeFor('g1').clearMedia()
    expect(cache.size).toBe(10)
  })

  it('finds only the files earlier builds saved to storage', () => {
    expect(
      legacyMediaKeys([
        'marmot:account:abc:media:ff:00',
        'marmot:media:ff:00',
        'marmot:account:abc:groups:media:',
        'marmot:account:abc:history:ff:00',
        'relays'
      ])
    ).toEqual(['marmot:account:abc:media:ff:00', 'marmot:media:ff:00'])
  })
})

describe('refresh queue', () => {
  it('merges a burst into one run, and requests during a run into one more', async () => {
    let finish = (): void => {}
    const task = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const refresh = coalesce(task, 50)
    const first = Promise.all([refresh(), refresh(), refresh()])
    await vi.advanceTimersByTimeAsync(50)
    expect(task).toHaveBeenCalledTimes(1)
    let lateDone = false
    const late = Promise.all([refresh(), refresh()]).then(() => (lateDone = true))
    await vi.advanceTimersByTimeAsync(500)
    expect(task).toHaveBeenCalledTimes(1)
    finish()
    await first
    await vi.advanceTimersByTimeAsync(50)
    expect(task).toHaveBeenCalledTimes(2)
    expect(lateDone).toBe(false)
    finish()
    await late
  })

  it('reports a failure and keeps working', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValue(undefined)
    const refresh = coalesce(task)
    const failed = expect(refresh()).rejects.toThrow('no')
    await vi.advanceTimersByTimeAsync(1)
    await failed
    const next = refresh()
    await vi.advanceTimersByTimeAsync(1)
    await next
  })
})

describe('direct chat lookup', () => {
  it('reuses only a group containing exactly the active account and selected contact', () => {
    const account = 'a'.repeat(64)
    const contact = 'b'.repeat(64)
    const matching = { snapshot: { members: [account, contact] } }
    const groups = [
      { snapshot: { members: [account, contact, 'c'.repeat(64)] } },
      { snapshot: { members: [account, 'c'.repeat(64)] } },
      matching
    ]

    expect(findDirectChat(groups, account, contact)).toBe(matching)
    expect(findDirectChat(groups.slice(0, 2), account, contact)).toBeNull()
  })

  it('reuses a persisted direct chat before looking up a key package or creating a group', async () => {
    const account = 'a'.repeat(64)
    const contact = 'b'.repeat(64)
    const existing = { snapshot: { id: 'stored-group', members: [account, contact] } }
    const client = {
      signer: { getPublicKey: async () => account },
      groups: { loadAll: async () => [existing] },
      network: { request: vi.fn() }
    }
    const createGroup = vi.fn()
    const result = await createOrReuseDirectChat({
      client,
      relays: ['wss://relay.example'],
      address: contact,
      name: 'Contact',
      decodeAddress: (value: string) => value,
      createGroup
    })

    expect(result).toBe(existing)
    expect(client.network.request).not.toHaveBeenCalled()
    expect(createGroup).not.toHaveBeenCalled()
  })

  it('coalesces concurrent start-chat requests for the same account pair', async () => {
    const account = 'a'.repeat(64)
    const contact = 'b'.repeat(64)
    const created = { snapshot: { id: 'new-group', members: [account, contact] } }
    let finishCreate: (group: typeof created) => void = () => undefined
    const client = {
      signer: { getPublicKey: async () => account },
      groups: { loadAll: vi.fn(async () => []) },
      network: { request: vi.fn() }
    }
    const createGroup = vi.fn(() => new Promise<typeof created>(resolve => { finishCreate = resolve }))
    const options = {
      client,
      relays: ['wss://relay.example'],
      address: contact,
      name: 'Contact',
      decodeAddress: (value: string) => value,
      createGroup
    }

    const first = createOrReuseDirectChat(options)
    const second = createOrReuseDirectChat(options)
    await Promise.resolve()
    await Promise.resolve()
    expect(client.groups.loadAll).toHaveBeenCalledTimes(1)
    expect(createGroup).toHaveBeenCalledTimes(1)
    finishCreate(created)
    await expect(Promise.all([first, second])).resolves.toEqual([created, created])
  })
})

describe('published KeyPackage selection', () => {
  it('falls back from an expired newest slot to the newest usable slot', async () => {
    const newest = { id: 'newest', created_at: 20 }
    const usable = { id: 'usable', created_at: 10 }
    const buildInviteIntent = vi.fn(async event => {
      if (event.id === 'newest') throw new Error('createInviteIntent: KeyPackage lifetime exceeds cap or is not current')
      return { kind: 'commit', eventId: event.id }
    })

    await expect(selectUsableKeyPackage([usable, newest, newest], buildInviteIntent)).resolves.toEqual({
      keyPackage: usable,
      intent: { kind: 'commit', eventId: 'usable' }
    })
    expect(buildInviteIntent.mock.calls.map(([event]) => event.id)).toEqual(['newest', 'usable'])
  })

  it('reports expired packages only when no published slot is usable', async () => {
    const buildInviteIntent = vi.fn(async () => { throw new Error('createInviteIntent: KeyPackage lifetime exceeds cap or is not current') })
    await expect(selectUsableKeyPackage([{ id: 'a', created_at: 2 }, { id: 'b', created_at: 1 }], buildInviteIntent))
      .rejects.toThrow('The contact’s available invite keys are expired or not yet valid.')
  })
})

describe('group relay updates', () => {
  it('updates changed relay metadata only for groups administered by this account', () => {
    const relays = ['wss://relay.new']
    const account = 'a'.repeat(64)
    const other = 'b'.repeat(64)
    const adminGroup = { idStr: 'admin-id', id: new Uint8Array([1]), snapshot: { groupData: { name: 'My group', relays: ['wss://relay.old'], adminPubkeys: [account] } } }
    const memberGroup = { idStr: 'member-id', id: new Uint8Array([2]), snapshot: { groupData: { name: 'Shared group', relays: ['wss://relay.old'], adminPubkeys: [other] } } }
    const unchangedGroup = { idStr: 'same-id', id: new Uint8Array([3]), snapshot: { groupData: { name: 'Already current', relays, adminPubkeys: [other] } } }

    const plan = planGroupRelayUpdates([adminGroup, memberGroup, unchangedGroup], account, relays)
    expect(plan.update).toEqual([{ group: adminGroup, name: 'My group' }])
    expect(plan.adminRequired).toEqual(['Shared group'])
  })

  it('uses the group ID as the label when metadata has no name', () => {
    const group = { idStr: 'unnamed-group', snapshot: { groupData: { relays: ['wss://relay.old'], adminPubkeys: [] } } }
    expect(planGroupRelayUpdates([group], 'account', ['wss://relay.new']).adminRequired).toEqual(['unnamed-group'])
  })
})

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  sent: any[][] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  receive(...frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function relays(signAuth = vi.fn(async () => ({ id: 'auth-event' }))) {
  FakeSocket.all = []
  return {
    signAuth,
    pool: createLiveRelays({ signAuth, createSocket: (url: string) => new FakeSocket(url) })
  }
}

describe('live relay subscriptions', () => {
  it('shares one open connection and delivers each event once', async () => {
    const { pool } = relays()
    const seen: string[] = []
    const observer = { next: (event: { id: string }) => seen.push(event.id) }
    pool.subscribe(['wss://a', 'wss://b'], [{ kinds: [445] }], observer)
    pool.subscribe(['wss://a'], [{ kinds: [1059] }], { next: () => {} })
    expect(FakeSocket.all.map((socket) => socket.url)).toEqual(['wss://a', 'wss://b'])
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket]
    a.open()
    b.open()
    const id = a.sent[0]![1]
    expect(a.sent).toHaveLength(2)
    a.receive('EVENT', id, { id: 'e1' })
    a.receive('EOSE', id)
    b.receive('EVENT', id, { id: 'e1' })
    b.receive('EVENT', id, { id: 'e2' })
    expect(seen).toEqual(['e1', 'e2'])
    // Ten quiet-free minutes with a relay that keeps answering: nothing new is opened.
    for (let minute = 0; minute < 10; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      a.receive('EOSE', 'ncc-ping')
      b.receive('EOSE', 'ncc-ping')
    }
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('reconnects after a drop and asks only for what it may have missed', async () => {
    const { pool } = relays()
    pool.subscribe(['wss://a'], [{ kinds: [445], since: 100 }], {})
    const first = FakeSocket.all[0]!
    first.open()
    const id = first.sent[0]![1]
    expect(first.sent[0]![2]).toEqual({ kinds: [445], since: 100 })
    first.receive('EOSE', id)
    const alive = Math.floor(Date.now() / 1000)
    first.onclose!()
    await vi.advanceTimersByTimeAsync(1000)
    const second = FakeSocket.all[1]!
    second.open()
    expect(second.sent[0]).toEqual(['REQ', id, { kinds: [445], since: alive - 3600 }])
  })

  it('replaces a connection that stops answering', async () => {
    const { pool } = relays()
    pool.subscribe(['wss://a'], [{ kinds: [445] }], {})
    FakeSocket.all[0]!.open()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.all[0]!.sent.at(-1)![1]).toBe('ncc-ping')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('signs in once per connection and then repeats its requests', async () => {
    const { pool, signAuth } = relays()
    pool.subscribe(['wss://a'], [{ kinds: [1059] }], {})
    const socket = FakeSocket.all[0]!
    socket.open()
    const id = socket.sent[0]![1]
    socket.receive('AUTH', 'challenge')
    socket.receive('CLOSED', id, 'auth-required: sign in')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent.at(-1)).toEqual(['AUTH', { id: 'auth-event' }])
    socket.receive('OK', 'auth-event', true)
    expect(socket.sent.at(-1)![0]).toBe('REQ')
    expect(signAuth).toHaveBeenCalledTimes(1)
  })

  it('waits minutes before asking again after sign-in is refused', async () => {
    const signAuth = vi.fn(async () => {
      throw new Error('declined')
    })
    const { pool } = relays(signAuth as never)
    pool.subscribe(['wss://a'], [{ kinds: [1059] }], {})
    FakeSocket.all[0]!.open()
    FakeSocket.all[0]!.receive('AUTH', 'challenge')
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(FakeSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('closes the connection when nothing is subscribed and ignores its late callbacks', async () => {
    const { pool } = relays()
    const stop = pool.subscribe(['wss://a'], [{ kinds: [445] }], {})
    const socket = FakeSocket.all[0]!
    socket.open()
    stop()
    expect(socket.sent.at(-1)![0]).toBe('CLOSE')
    expect(socket.readyState).toBe(3)
    expect(socket.onclose).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(pool.connections).toBe(0)
  })

  it('allows for backdated invitations when resuming', () => {
    const at = Date.now()
    expect(resumeFilters([{ kinds: [1059] }], at)[0].since).toBe(at / 1000 - 3 * 86400)
    expect(resumeFilters([{ kinds: [1059] }], null)).toEqual([{ kinds: [1059] }])
  })
})
