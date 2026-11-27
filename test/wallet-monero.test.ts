import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateRestoreHeight, MoneroSyncCancelled, MoneroWalletSession, normalizeSyncPercent, parseXmrAmount, resolveRestoreHeight } from '../src/shared/monero-wallet'

describe('Monero amount parsing', () => {
  it('parses XMR decimals exactly into atomic units', () => {
    expect(parseXmrAmount('0.000000000001')).toBe(1n)
    expect(parseXmrAmount('1.234567890123')).toBe(1_234_567_890_123n)
  })

  it('rejects precision beyond atomic units and invalid amounts', () => {
    expect(() => parseXmrAmount('0.0000000000001')).toThrow(/12 decimal places/)
    expect(() => parseXmrAmount('0')).toThrow(/greater than zero/)
    expect(() => parseXmrAmount('-1')).toThrow(/12 decimal places/)
  })
})

describe('Monero sync progress', () => {
  it('converts the 0-1 fraction from monero-ts into a clamped percentage', () => {
    expect(normalizeSyncPercent(0)).toBe(0)
    expect(normalizeSyncPercent(0.4)).toBe(40)
    expect(normalizeSyncPercent(1.2)).toBe(100)
    expect(normalizeSyncPercent(Number.NaN)).toBe(0)
  })
})

describe('where a new wallet starts scanning', () => {
  // Real mainnet blocks: [height, time it was mined].
  it.each([
    [3_030_000, 1_701_417_489],
    [3_290_000, 1_732_645_674],
    [3_550_000, 1_763_878_670],
    [3_815_000, 1_795_722_139]
  ])('is shortly before block %i on the day it was mined', (height, time) => {
    const behind = height - estimateRestoreHeight(time * 1000)
    // Never past the tip, which would miss funds, and never months behind it.
    expect(behind).toBeGreaterThan(3_500)
    expect(behind).toBeLessThan(6_500)
  })
})

describe('where a restored wallet starts scanning', () => {
  const now = Date.UTC(2026, 10, 27)

  // Real mainnet blocks that are not among the built-in ones: [height, time it was mined].
  it.each([
    [1_030_000, '2016-04-20', 1_461_174_469],
    [3_030_000, '2023-12-01', 1_701_417_489],
    [3_550_000, '2025-11-23', 1_763_878_670],
    [3_750_000, '2026-08-28', 1_787_914_561]
  ])('is weeks before block %i for the day it was mined, %s', (height, date) => {
    const behind = height - resolveRestoreHeight({ date }, now)
    expect(behind).toBeGreaterThan(20_000)
    expect(behind).toBeLessThan(25_000)
  })

  it('is the start of the chain for a date before it', () => {
    expect(resolveRestoreHeight({ date: '2013-01-01' }, now)).toBe(0)
  })

  it('uses a typed block height as it is, ahead of the date', () => {
    expect(resolveRestoreHeight({ date: '2025-01-01', height: '0' }, now)).toBe(0)
    expect(resolveRestoreHeight({ height: ' 3000000 ' }, now)).toBe(3_000_000)
  })

  it('never guesses, or accepts a start that would skip blocks not yet mined', () => {
    expect(() => resolveRestoreHeight({ date: '', height: '' }, now)).toThrow(/when the wallet was created/)
    expect(() => resolveRestoreHeight({ date: '2027-01-01' }, now)).toThrow(/future/)
    expect(() => resolveRestoreHeight({ date: '2025-02-30' }, now)).toThrow(/year-month-day/)
    expect(() => resolveRestoreHeight({ height: '9000000' }, now)).toThrow(/not been reached/)
    expect(() => resolveRestoreHeight({ height: '-1' }, now)).toThrow(/whole number/)
  })
})

/** Just enough of monero-ts: each round of `sync` runs until it finishes or is stopped. */
function fakeEngine(tip: number, blocksPerSecond = 10) {
  const wallets: FakeWallet[] = []
  class FakeWallet {
    closed = false
    rounds = 0
    private stopped: (() => void) | null = null
    private listener: { onSyncProgress: (...args: unknown[]) => Promise<void> } | null = null
    constructor(public height: number, public address: string, readonly source: 'seed' | 'cache') { wallets.push(this) }
    sync(listener: FakeWallet['listener']) {
      this.rounds++
      this.listener = listener
      const start = this.height
      return new Promise<void>((resolve) => {
        const step = setInterval(() => {
          this.height = Math.min(tip, this.height + blocksPerSecond)
          void this.listener?.onSyncProgress(this.height, start, tip, 0, '')
          if (this.height >= tip) done()
        }, 1_000)
        const done = () => { clearInterval(step); this.stopped = null; resolve() }
        this.stopped = done
      })
    }
    async stopSyncing() { this.stopped?.() }
    async close() { this.closed = true }
    async getHeight() { return this.height }
    async getDaemonHeight() { return tip }
    async getPrimaryAddress() { return this.address }
    async getBalance() { return 0n }
    async getUnlockedBalance() { return 0n }
    async getTxs() { return [] }
    async getData() { return [new DataView(new Uint8Array([this.height]).buffer), new DataView(new Uint8Array([1]).buffer)] }
  }
  const monero = {
    MoneroWalletListener: class {},
    createWalletFull: async (config: { restoreHeight: number }) => new FakeWallet(config.restoreHeight, '4mine', 'seed'),
    openWalletFull: async (config: { keysData: Uint8Array; cacheData: Uint8Array }) => new FakeWallet(config.keysData[0], config.cacheData[0] === 1 ? '4mine' : '4other', 'cache')
  }
  const session = (checkpointMs = 30_000) => {
    const created = new MoneroWalletSession(checkpointMs)
    Object.assign(created, { loadRuntime: Promise.resolve(monero) })
    return created
  }
  return { wallets, session }
}

const saved = { seed: 'words', daemonUrl: 'https://node.example', restoreHeight: 0, address: '4mine' }

describe('a long Monero scan', () => {
  afterEach(() => { vi.useRealTimers() })

  it('saves as it goes and reports progress across the whole scan', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine(1_000)
    const session = engine.session()
    await session.open(saved)
    const heights: number[] = []
    const result = session.sync(async (data) => { heights.push(atob(data.keysData).charCodeAt(0)) })
    await vi.advanceTimersByTimeAsync(65_000)
    expect(heights.length).toBe(2)
    expect(session.progress.startHeight).toBe(0)
    expect(session.progress.percent).toBeGreaterThan(60)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(result).resolves.toMatchObject({ height: 1_000 })
    expect(heights.length).toBe(4)
    expect(engine.wallets[0].rounds).toBe(4)
    expect(session.isSyncing).toBe(false)
  })

  it('saves before stopping when closed part way', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine(1_000)
    const session = engine.session()
    await session.open(saved)
    const save = vi.fn(async () => undefined)
    const result = expect(session.sync(save)).rejects.toBeInstanceOf(MoneroSyncCancelled)
    await vi.advanceTimersByTimeAsync(5_000)
    const closing = session.close()
    await vi.advanceTimersByTimeAsync(1_000)
    await closing
    await result
    expect(save).toHaveBeenCalledTimes(1)
    expect(engine.wallets[0].closed).toBe(true)
    expect(engine.wallets[0].height).toBeLessThan(1_000)
    expect(session.isOpen).toBe(false)
  })

  it('carries on after the screen is left, and closes when it finishes', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine(500)
    const session = engine.session()
    await session.open(saved)
    const result = session.sync()
    session.release()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(result).resolves.toMatchObject({ height: 500 })
    expect(engine.wallets[0].closed).toBe(true)
  })

  it('is rejoined, not restarted, when the screen is opened again', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine(500)
    const session = engine.session()
    await session.open(saved)
    const first = session.sync()
    session.release()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(session.open(saved)).resolves.toMatchObject({ address: '4mine' })
    const second = session.sync()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(second).resolves.toEqual(await first)
    expect(engine.wallets).toHaveLength(1)
    expect(engine.wallets[0].closed).toBe(false)
  })

  it('stops the old scan before opening against another node', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine(500)
    const session = engine.session()
    await session.open(saved)
    const old = expect(session.sync()).rejects.toBeInstanceOf(MoneroSyncCancelled)
    await vi.advanceTimersByTimeAsync(3_000)
    const reopened = session.open({ ...saved, daemonUrl: 'https://other.example' })
    await vi.advanceTimersByTimeAsync(2_000)
    await reopened
    await old
    expect(engine.wallets.map((wallet) => wallet.closed)).toEqual([true, false])
  })

  it('resumes from a saved cache, unless the cache is for another wallet', async () => {
    const engine = fakeEngine(500)
    const cache = (address: number) => async () => ({ keysData: btoa(String.fromCharCode(200)), cacheData: btoa(String.fromCharCode(address)) })
    await expect(engine.session().open({ ...saved, loadWalletData: cache(1) })).resolves.toMatchObject({ height: 200, address: '4mine' })
    await expect(engine.session().open({ ...saved, loadWalletData: cache(2) })).resolves.toMatchObject({ height: 0, address: '4mine' })
    expect(engine.wallets.map((wallet) => [wallet.source, wallet.closed])).toEqual([['cache', false], ['cache', true], ['seed', false]])
  })
})
