import type { MoneroWalletFull } from 'monero-ts'

const ATOMIC_UNITS = 1_000_000_000_000n

/**
 * Real mainnet blocks as [height, unix seconds]: the first one, the 2016 change from one
 * to two minute blocks, about two a year, and a recent one. They turn a date into a
 * height without telling a node when a wallet was made.
 */
const BLOCK_TIMES: readonly (readonly [number, number])[] = [
  [1, 1397818193], [372369, 1420070417], [631184, 1435708870], [892866, 1451606570], [1009827, 1458748658],
  [1081269, 1467331963], [1213861, 1483228937], [1344225, 1498867297], [1477201, 1514765258], [1606715, 1530403252],
  [1738923, 1546300902], [1868590, 1561939442], [2001315, 1577836856], [2132318, 1593561618], [2264584, 1609459423],
  [2394882, 1625097665], [2527316, 1640995217], [2657395, 1656634014], [2789763, 1672531303], [2919771, 1688169604],
  [3051991, 1704067334], [3182945, 1719792073], [3315383, 1735690117], [3445678, 1751328182], [3577876, 1767225856],
  [3707958, 1782864243], [3815145, 1795736423]
]
const BLOCK_SECONDS = 120
/** About a week. It also absorbs blocks arriving a little slower than every two minutes. */
const NEW_WALLET_MARGIN = 5_040
/** About a month, because a remembered date is rarely exact. */
const RESTORE_DATE_MARGIN = 21_600
/** How often a long scan pauses to save, and so the most work a closed app can lose. */
const CHECKPOINT_MS = 90_000
const NO_FILESYSTEM = {
  promises: Object.fromEntries(['access', 'copyFile', 'mkdir', 'open', 'readFile', 'rename', 'rmdir', 'stat', 'unlink', 'writeFile'].map((name) => [name, async () => { throw new Error(`Unexpected wallet filesystem operation: ${name}`) }]))
}

export type MoneroSnapshot = {
  address: string
  balance: string
  unlocked: string
  height: number
  transactions: { id: string; direction: 'incoming' | 'outgoing'; amount: string; fee: string; confirmations: number; timestamp: number; status: 'confirmed' | 'pending' | 'failed' }[]
}
export type MoneroSendPreview = { id: string; address: string; amount: string; fee: string; transactions: number }
export type MoneroWalletData = { keysData: string; cacheData: string }
export type MoneroOpenOptions = {
  seed: string
  daemonUrl: string
  restoreHeight: number
  seedOffset?: string
  /** The saved primary address. A cache belonging to any other wallet is ignored. */
  address?: string
  /** Read only once an earlier wallet has closed, so its last checkpoint is included. */
  loadWalletData?: () => Promise<MoneroWalletData | null | undefined>
}
export type MoneroSaveCache = (data: MoneroWalletData) => Promise<void>

export class MoneroSyncCancelled extends Error {
  constructor() { super('Monero wallet scan was stopped') }
}

/** Roughly the chain's height at a time. Between known blocks it errs by hours at most. */
function heightAt(time: number): number {
  const seconds = time / 1000
  const next = BLOCK_TIMES.findIndex(([, mined]) => mined > seconds)
  if (next === 0) return 0
  if (next < 0) {
    const [height, mined] = BLOCK_TIMES[BLOCK_TIMES.length - 1]
    return height + Math.floor((seconds - mined) / BLOCK_SECONDS)
  }
  const [from, to] = [BLOCK_TIMES[next - 1], BLOCK_TIMES[next]]
  return from[0] + Math.floor(((seconds - from[1]) * (to[0] - from[0])) / (to[1] - from[1]))
}

/** Where a wallet created now can safely start scanning. */
export function estimateRestoreHeight(now = Date.now()): number {
  return Math.max(0, heightAt(now) - NEW_WALLET_MARGIN)
}

/**
 * Where to start scanning a restored wallet, from a block height if one was typed, and
 * otherwise from the `YYYY-MM-DD` date it was created. Starting too late hides funds, so
 * neither is guessed: scanning the whole chain has to be asked for with height 0.
 */
export function resolveRestoreHeight(input: { date?: string; height?: string }, now = Date.now()): number {
  const typed = input.height?.trim() ?? ''
  if (typed) {
    const height = Number(typed)
    if (!/^\d+$/.test(typed) || !Number.isSafeInteger(height)) throw new Error('Enter the block height as a whole number')
    // A day of slack, as the newest height is only an estimate.
    if (height > heightAt(now) + 720) throw new Error('That block height has not been reached yet')
    return height
  }
  const date = input.date?.trim() ?? ''
  if (!date) throw new Error('Enter roughly when the wallet was created. If you do not know, enter block height 0 to scan everything, which can take many hours.')
  const time = Date.parse(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error('Enter the date as year-month-day')
  // Today's date can begin up to 14 hours before it does in UTC.
  if (time > now + 14 * 3_600_000) throw new Error('The wallet creation date cannot be in the future')
  return Math.max(0, heightAt(time) - RESTORE_DATE_MARGIN)
}

/** monero-ts sync progress is a 0-1 fraction; the UI wants 0-100, clamped. */
export function normalizeSyncPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  return Math.min(100, Math.max(0, fraction * 100))
}

export function parseXmrAmount(input: string): bigint {
  const value = input.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) throw new Error('Enter an XMR amount with up to 12 decimal places')
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole) * ATOMIC_UNITS + BigInt(fraction.padEnd(12, '0') || '0')
  if (amount <= 0n) throw new Error('Amount must be greater than zero')
  return amount
}

function xmrText(amount: bigint): string {
  const whole = amount / ATOMIC_UNITS
  const fractional = (amount % ATOMIC_UNITS).toString().padStart(12, '0').replace(/0+$/, '')
  return fractional ? `${whole}.${fractional}` : whole.toString()
}

export class MoneroWalletSession {
  private wallet: MoneroWalletFull | null = null
  private pending = new Map<string, { txs: Awaited<ReturnType<MoneroWalletFull['createTxs']>>; preview: MoneroSendPreview }>()
  private loadRuntime: Promise<typeof import('monero-ts')> | null = null
  private syncing: Promise<MoneroSnapshot> | null = null
  private opening: Promise<unknown> | null = null
  private openKey = ''
  private generation = 0
  private released = false
  /** `percent` is 0-100 across the whole scan, not just the part since the last checkpoint. */
  progress = { height: 0, startHeight: 0, endHeight: 0, percent: 0, message: '' }
  /** The newest snapshot, readable while a scan holds the wallet busy. */
  lastSnapshot: MoneroSnapshot | null = null
  /** Why the latest checkpoint could not be saved, or null. */
  saveError: string | null = null

  constructor(private readonly checkpointMs = CHECKPOINT_MS) {}

  get isOpen(): boolean { return this.wallet !== null }
  get isSyncing(): boolean { return this.syncing !== null }

  /** Opens a wallet, or rejoins it, along with any scan it is running, if it is already open. */
  async open(options: MoneroOpenOptions): Promise<MoneroSnapshot> {
    this.released = false
    while (this.opening) await this.opening.catch(() => undefined)
    const key = JSON.stringify([options.seed, options.seedOffset ?? '', options.daemonUrl, options.restoreHeight])
    if (this.wallet && this.openKey === key) {
      if (this.syncing && this.lastSnapshot) return this.lastSnapshot
      return this.snapshot()
    }
    const opening = this.openWallet(options, key)
    this.opening = opening
    try { return await opening }
    finally { if (this.opening === opening) this.opening = null }
  }

  private async openWallet(options: MoneroOpenOptions, key: string): Promise<MoneroSnapshot> {
    await this.closeWallet()
    const generation = this.generation
    const monero = await this.runtime()
    const common = { path: '', password: '', networkType: 'mainnet' as const, server: options.daemonUrl, proxyToWorker: true, fs: NO_FILESYSTEM }
    const fromSeed = () => monero.createWalletFull({ ...common, seed: options.seed, seedOffset: options.seedOffset ?? '', restoreHeight: Math.max(0, Math.floor(options.restoreHeight)) })
    const walletData = await options.loadWalletData?.().catch(() => null)
    let wallet: MoneroWalletFull | null = null
    if (walletData) {
      try {
        wallet = await monero.openWalletFull({ ...common, keysData: decodeWalletData(walletData.keysData), cacheData: decodeWalletData(walletData.cacheData) })
        if (options.address && await wallet.getPrimaryAddress() !== options.address) {
          await wallet.close(false)
          wallet = null
        }
      } catch {
        // A stale or incompatible cache must not make a valid recovery seed unusable.
        wallet = null
      }
    }
    wallet ??= await fromSeed()
    const actualAddress = await wallet.getPrimaryAddress()
    if (!actualAddress.startsWith('4') && !actualAddress.startsWith('8')) {
      await wallet.close(false)
      throw new Error('The restored seed did not produce a valid Monero mainnet address')
    }
    if (generation !== this.generation) {
      await wallet.close(false)
      throw new MoneroSyncCancelled()
    }
    this.wallet = wallet
    this.openKey = key
    return this.snapshot()
  }

  async create(daemonUrl: string): Promise<{ seed: string; address: string; restoreHeight: number }> {
    if (this.wallet) await this.close()
    const monero = await this.runtime()
    void daemonUrl // Key generation stays offline; scanning connects only when the user starts sync.
    const wallet = await monero.createWalletFull({ path: '', password: '', networkType: 'mainnet', proxyToWorker: true, fs: NO_FILESYSTEM })
    const seed = await wallet.getSeed()
    const address = await wallet.getPrimaryAddress()
    await wallet.close(false)
    return { seed, address, restoreHeight: estimateRestoreHeight() }
  }

  async deriveAddress(seed: string, seedOffset = ''): Promise<string> {
    const monero = await this.runtime()
    const keys = await monero.createWalletKeys({ path: '', password: '', networkType: 'mainnet', seed, seedOffset, proxyToWorker: true, fs: NO_FILESYSTEM })
    try { return await keys.getPrimaryAddress() }
    finally { await keys.close(false) }
  }

  /**
   * Scans up to the daemon's height, pausing now and then to hand `save` the progress
   * made. A second call joins the scan already running.
   */
  async sync(save?: MoneroSaveCache): Promise<MoneroSnapshot> {
    if (this.syncing) return this.syncing
    const syncing = this.scan(this.requireWallet(), save)
    this.syncing = syncing
    try { return await syncing }
    finally {
      if (this.syncing === syncing) this.syncing = null
      if (this.released) void this.close()
    }
  }

  private async scan(wallet: MoneroWalletFull, save?: MoneroSaveCache): Promise<MoneroSnapshot> {
    const generation = this.generation
    const cancelled = () => generation !== this.generation
    const monero = await this.runtime()
    let firstHeight: number | null = null
    const listener = new monero.MoneroWalletListener()
    listener.onSyncProgress = async (height, startHeight, endHeight, _percent, message) => {
      firstHeight ??= startHeight
      this.progress = { height, startHeight: firstHeight, endHeight, percent: normalizeSyncPercent((height - firstHeight) / Math.max(1, endHeight - firstHeight)), message }
    }
    this.progress = { height: 0, startHeight: 0, endHeight: 0, percent: 0, message: '' }
    for (;;) {
      if (cancelled()) throw new MoneroSyncCancelled()
      const began = Date.now()
      let paused = false
      // Repeated until the round ends: a stop sent before the scan has begun is forgotten.
      const timer = setInterval(() => {
        if (!cancelled() && Date.now() - began < this.checkpointMs) return
        paused = true
        void wallet.stopSyncing().catch(() => undefined)
      }, 1_000)
      try { await wallet.sync(listener) }
      catch (error) { if (!cancelled()) throw error }
      finally { clearInterval(timer) }
      if (save) {
        try {
          await save(await this.exportWalletData())
          this.saveError = null
        } catch (error) { this.saveError = error instanceof Error ? error.message : String(error) }
      }
      // Asked only after saving, so a node that stops answering cannot cost the progress.
      const done = !paused || await wallet.getHeight() >= await wallet.getDaemonHeight()
      const snapshot = await this.snapshot()
      if (done) return snapshot
    }
  }

  async exportWalletData(): Promise<MoneroWalletData> {
    const data = await this.requireWallet().getData()
    if (data.length !== 2) throw new Error('Monero wallet returned incomplete cache data')
    return { keysData: encodeWalletData(data[0]), cacheData: encodeWalletData(data[1]) }
  }

  async snapshot(): Promise<MoneroSnapshot> {
    const wallet = this.requireWallet()
    const [address, balance, unlocked, height, txs] = await Promise.all([
      wallet.getPrimaryAddress(), wallet.getBalance(), wallet.getUnlockedBalance(), wallet.getHeight(), wallet.getTxs()
    ])
    const transactions = txs.map((tx) => ({
      id: tx.getHash(), direction: tx.getIsIncoming() ? 'incoming' as const : 'outgoing' as const,
      amount: xmrText(tx.getIsIncoming() ? tx.getIncomingAmount() : tx.getOutgoingAmount()),
      fee: xmrText(tx.getFee()), confirmations: tx.getIsConfirmed() ? Math.max(1, height - tx.getHeight() + 1) : 0,
      timestamp: tx.receivedTimestamp * 1000, status: tx.getIsFailed() ? 'failed' as const : tx.getIsConfirmed() ? 'confirmed' as const : 'pending' as const
    })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)
    this.lastSnapshot = { address, balance: xmrText(balance), unlocked: xmrText(unlocked), height, transactions }
    return this.lastSnapshot
  }

  async prepareSend(address: string, amount: string): Promise<MoneroSendPreview> {
    if (!/^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(address.trim())) throw new Error('Enter a valid Monero mainnet address')
    const txs = await this.requireWallet().createTxs({ address: address.trim(), amount: parseXmrAmount(amount), relay: false, canSplit: true })
    if (!txs.length) throw new Error('Monero wallet did not create a transaction')
    const totalFee = txs.reduce((sum, tx) => sum + tx.getFee(), 0n)
    const totalAmount = txs.reduce((sum, tx) => sum + tx.getOutgoingAmount(), 0n)
    const id = crypto.randomUUID()
    const preview = { id, address: address.trim(), amount: xmrText(totalAmount), fee: xmrText(totalFee), transactions: txs.length }
    this.pending.set(id, { txs, preview })
    return preview
  }

  async confirmSend(id: string): Promise<string[]> {
    const item = this.pending.get(id)
    if (!item) throw new Error('Monero send preview expired; review the transaction again')
    this.pending.delete(id)
    return this.requireWallet().relayTxs(item.txs)
  }

  /** Stops any scan, which saves its progress first, then closes the wallet. */
  async close(): Promise<void> {
    this.generation++
    if (this.opening) await this.opening.catch(() => undefined)
    await this.closeWallet()
  }

  /** The wallet screen was left: let a running scan finish, then close. `open` takes it back. */
  release(): void {
    this.released = true
    if (!this.syncing && !this.opening) void this.close()
  }

  private async closeWallet(): Promise<void> {
    const wallet = this.wallet
    if (this.syncing) {
      this.generation++
      await this.syncing.catch(() => undefined)
    }
    this.pending.clear()
    this.lastSnapshot = null
    this.openKey = ''
    if (this.wallet === wallet) this.wallet = null
    if (wallet) await wallet.close(false).catch(() => undefined)
  }

  private async runtime(): Promise<typeof import('monero-ts')> {
    if (!this.loadRuntime) this.loadRuntime = import('monero-ts').then((monero) => {
      monero.LibraryUtils.setWorkerLoader(() => new Worker(new URL('monero.worker.js', document.baseURI)))
      return monero
    })
    return this.loadRuntime
  }

  private requireWallet(): MoneroWalletFull {
    if (!this.wallet) throw new Error('Open the Monero wallet first')
    return this.wallet
  }
}

function encodeWalletData(data: DataView): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function decodeWalletData(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
