import type { MoneroWalletFull } from 'monero-ts'

const ATOMIC_UNITS = 1_000_000_000_000n
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
  progress = { height: 0, startHeight: 0, endHeight: 0, percent: 0, message: '' }

  async open(options: { seed: string; daemonUrl: string; restoreHeight: number; seedOffset?: string }): Promise<MoneroSnapshot> {
    if (this.wallet) await this.close()
    const monero = await this.runtime()
    this.wallet = await monero.createWalletFull({
      path: '', password: '', networkType: 'mainnet', seed: options.seed,
      seedOffset: options.seedOffset ?? '', restoreHeight: Math.max(0, Math.floor(options.restoreHeight)),
      server: options.daemonUrl, proxyToWorker: true, fs: NO_FILESYSTEM
    })
    const actualAddress = await this.wallet.getPrimaryAddress()
    if (!actualAddress.startsWith('4') && !actualAddress.startsWith('8')) {
      await this.close()
      throw new Error('The restored seed did not produce a valid Monero mainnet address')
    }
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
    const estimatedTip = Math.floor((Date.now() / 1000 - 1_397_818_193) / 120)
    return { seed, address, restoreHeight: Math.max(0, estimatedTip - 5_040) }
  }

  async deriveAddress(seed: string, seedOffset = ''): Promise<string> {
    const monero = await this.runtime()
    const keys = await monero.createWalletKeys({ path: '', password: '', networkType: 'mainnet', seed, seedOffset, proxyToWorker: true, fs: NO_FILESYSTEM })
    try { return await keys.getPrimaryAddress() }
    finally { await keys.close(false) }
  }

  async sync(): Promise<MoneroSnapshot> {
    const wallet = this.requireWallet()
    const monero = await this.runtime()
    const listener = new monero.MoneroWalletListener()
    listener.onSyncProgress = async (height, startHeight, endHeight, percent, message) => { this.progress = { height, startHeight, endHeight, percent, message } }
    await wallet.sync(listener)
    return this.snapshot()
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
    return { address, balance: xmrText(balance), unlocked: xmrText(unlocked), height, transactions }
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

  async close(): Promise<void> {
    this.pending.clear()
    if (this.wallet) await this.wallet.close(false).catch(() => undefined)
    this.wallet = null
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
