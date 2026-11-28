import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { createMediaCache, legacyMediaKeys } from '../extensions/white-noise-prototype/media-cache.js'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { coalesce } from '../extensions/white-noise-prototype/refresh-queue.js'
// @ts-expect-error The extension is plain JavaScript without type declarations.
import { createLiveRelays, resumeFilters } from '../extensions/white-noise-prototype/relay-live.js'

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }))
afterEach(() => vi.useRealTimers())

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
