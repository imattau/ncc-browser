import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { p2tr, Transaction, utils as btcUtils, type Transaction as BtcTransaction } from '@scure/btc-signer'
import { hex } from '@scure/base'
import type { BitcoinSendPreview, WalletBalance, WalletTransaction } from '@shared/wallet'

type EsploraStats = {
  funded_txo_sum: number
  spent_txo_sum: number
  tx_count: number
}
type EsploraUtxo = { txid: string; vout: number; value: number; status: { confirmed: boolean } }
type EsploraTx = {
  txid: string
  status: { confirmed: boolean; block_time?: number; block_height?: number }
  vin: { prevout?: { scriptpubkey_address?: string; value?: number } }[]
  vout: { scriptpubkey_address?: string; value: number }[]
}

const SATS = 100_000_000
const DUST_SATS = 330
const PREVIEW_TTL = 90_000

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('The Bitcoin service returned invalid data')
  return value as Record<string, unknown>
}

function safeBaseUrl(input: string): string {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Enter a valid Esplora URL') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Esplora must use HTTPS (HTTP is allowed for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Esplora URL cannot include credentials or query parameters')
  return url.toString().replace(/\/$/, '')
}

export function bitcoinPayment(secret: Uint8Array) {
  if (secret.length !== 32) throw new Error('The active identity key is invalid')
  return p2tr(btcUtils.pubSchnorr(secret))
}

export function parseBtcAmount(value: string): number {
  const amount = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(amount)) throw new Error('Enter a valid BTC amount (up to 8 decimal places)')
  const [whole, fraction = ''] = amount.split('.')
  const sats = Number(whole) * SATS + Number(fraction.padEnd(8, '0'))
  if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('Amount must be greater than zero')
  return sats
}

export function formatBtc(sats: number): string {
  return (sats / SATS).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

export class BitcoinWallet {
  private readonly pending = new Map<string, { tx: BtcTransaction; secret: Uint8Array; expiresAt: number }>()
  private readonly baseUrl: string

  constructor(
    url: string,
    private readonly proxy: () => string | null = () => null,
    private readonly now = Date.now,
    private readonly requester = requestText
  ) {
    this.baseUrl = safeBaseUrl(url)
  }

  address(secret: Uint8Array): string {
    const address = bitcoinPayment(secret).address
    if (!address) throw new Error('Could not derive a Bitcoin address')
    return address
  }

  private async request(path: string, method = 'GET', body?: string): Promise<string> {
    const response = await this.requester(`${this.baseUrl}${path}`, method, body, this.proxy())
    if (response.status < 200 || response.status >= 300) throw new Error(`Bitcoin service returned HTTP ${response.status}`)
    return response.body
  }

  async snapshot(secret: Uint8Array): Promise<{ balance: WalletBalance; transactions: WalletTransaction[] }> {
    const address = this.address(secret)
    const [statsRaw, txsRaw] = await Promise.all([
      this.request(`/address/${encodeURIComponent(address)}`).then(JSON.parse),
      this.request(`/address/${encodeURIComponent(address)}/txs`).then(JSON.parse)
    ])
    const stats = asObject(statsRaw) as unknown as { chain_stats: EsploraStats; mempool_stats: EsploraStats }
    const chain = stats.chain_stats
    const mempool = stats.mempool_stats
    const confirmed = Math.max(0, chain.funded_txo_sum - chain.spent_txo_sum)
    const pending = Math.max(0, mempool.funded_txo_sum - mempool.spent_txo_sum)
    const txs = Array.isArray(txsRaw) ? (txsRaw as EsploraTx[]) : []
    return {
      balance: {
        currency: 'BTC', total: formatBtc(confirmed + pending), available: formatBtc(confirmed),
        pending: formatBtc(pending), updatedAt: this.now()
      },
      transactions: txs.slice(0, 30).map((tx) => {
        const incoming = tx.vout.filter((output) => output.scriptpubkey_address === address).reduce((sum, output) => sum + output.value, 0)
        const outgoing = tx.vin.filter((input) => input.prevout?.scriptpubkey_address === address).reduce((sum, input) => sum + (input.prevout?.value ?? 0), 0)
        const net = incoming - outgoing
        const tip = tx.status.block_height ?? 0
        return {
          currency: 'BTC', id: tx.txid, direction: net > 0 ? 'incoming' : net < 0 ? 'outgoing' : 'unknown',
          amount: formatBtc(Math.abs(net)), fee: null, confirmations: tx.status.confirmed ? Math.max(1, tip) : 0,
          timestamp: tx.status.block_time ?? null, status: tx.status.confirmed ? 'confirmed' : 'pending'
        }
      })
    }
  }

  async prepareSend(secret: Uint8Array, address: string, amountSats: number): Promise<BitcoinSendPreview> {
    if (!Number.isSafeInteger(amountSats) || amountSats < DUST_SATS) throw new Error('Amount is below the Bitcoin dust limit')
    const payment = bitcoinPayment(secret)
    const sourceAddress = payment.address
    if (!sourceAddress) throw new Error('Could not derive the Bitcoin address')
    // Validate the destination by asking the transaction library to encode its script.
    const utxos = JSON.parse(await this.request(`/address/${encodeURIComponent(sourceAddress)}/utxo`)) as EsploraUtxo[]
    const feesRaw = JSON.parse(await this.request('/fee-estimates'))
    const feeRates = asObject(feesRaw)
    const rate = Math.max(1, Math.ceil(Number(feeRates['3'] ?? feeRates['6'] ?? 2)))
    const spendable = utxos.filter((utxo) => utxo.status.confirmed && utxo.value > 0).sort((a, b) => b.value - a.value)
    if (spendable.length === 0) throw new Error('No confirmed Bitcoin outputs are available to spend')
    const tx = new Transaction()
    let totalInput = 0
    let required = amountSats + Math.ceil(150 * rate)
    for (const utxo of spendable) {
      tx.addInput({ ...payment, txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) } })
      totalInput += utxo.value
      if (totalInput >= required) break
      required = amountSats + Math.ceil((150 + tx.inputsLength * 58) * rate)
    }
    if (totalInput < required) throw new Error('Bitcoin balance is too low to cover the amount and network fee')
    tx.addOutputAddress(address.trim(), BigInt(amountSats))
    const estimatedFee = Math.ceil((150 + tx.inputsLength * 58) * rate)
    const change = totalInput - amountSats - estimatedFee
    if (change > DUST_SATS) tx.addOutputAddress(sourceAddress, BigInt(change))
    const feeSats = totalInput - amountSats - (change > DUST_SATS ? change : 0)
    const token = randomUUID()
    const expiresAt = this.now() + PREVIEW_TTL
    this.pending.set(token, { tx, secret: new Uint8Array(secret), expiresAt })
    return { token, address: address.trim(), amountSats, feeSats, totalSats: amountSats + feeSats, expiresAt }
  }

  async confirmSend(token: string): Promise<{ txid: string }> {
    const item = this.pending.get(token)
    this.pending.delete(token)
    if (!item || item.expiresAt < this.now()) throw new Error('The Bitcoin send preview expired; prepare it again')
    try {
      item.tx.sign(item.secret)
      item.tx.finalize()
      const txid = (await this.request('/tx', 'POST', item.tx.hex)).trim()
      if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Bitcoin service returned an invalid transaction id')
      return { txid }
    } finally {
      item.secret.fill(0)
    }
  }

  clear(): void {
    for (const item of this.pending.values()) item.secret.fill(0)
    this.pending.clear()
  }
}

async function requestText(
  input: string,
  method: string,
  body: string | undefined,
  proxy: string | null
): Promise<{ status: number; body: string }> {
  const url = new URL(input)
  const agent = proxy ? new SocksProxyAgent(proxy) : undefined
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method,
      agent,
      headers: body ? { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) } : undefined,
      timeout: 20_000
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('timeout', () => request.destroy(new Error('Bitcoin service request timed out')))
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}
