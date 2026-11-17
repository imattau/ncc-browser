import { describe, expect, it } from 'vitest'
import { p2tr, utils } from '@scure/btc-signer'
import { BitcoinWallet, formatBtc, parseBtcAmount } from '../src/main/wallet/bitcoin'

const secret = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 1 : 0)
const destinationKey = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 2 : 0)
const destination = p2tr(utils.pubSchnorr(destinationKey)).address!

describe('Bitcoin wallet', () => {
  it('parses decimal BTC amounts exactly as satoshis', () => {
    expect(parseBtcAmount('0.00000001')).toBe(1)
    expect(parseBtcAmount('1.23456789')).toBe(123_456_789)
    expect(formatBtc(100_000_000)).toBe('1')
    expect(() => parseBtcAmount('0.000000001')).toThrow(/8 decimal places/)
    expect(() => parseBtcAmount('0')).toThrow(/greater than zero/)
  })

  it('shows the balance/history and requires an explicit send confirmation before broadcast', async () => {
    const calls: { path: string; method: string; body?: string }[] = []
    const requester = async (url: string, method: string, body?: string) => {
      const path = new URL(url).pathname
      calls.push({ path, method, body })
      if (path.endsWith('/utxo')) return { status: 200, body: JSON.stringify([{ txid: '1'.repeat(64), vout: 0, value: 50_000, status: { confirmed: true } }]) }
      if (path.endsWith('/fee-estimates')) return { status: 200, body: JSON.stringify({ '3': 2 }) }
      if (path.endsWith('/txs')) return { status: 200, body: JSON.stringify([]) }
      if (path.includes('/address/') && !path.endsWith('/txs') && !path.endsWith('/utxo')) return { status: 200, body: JSON.stringify({ chain_stats: { funded_txo_sum: 50_000, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }) }
      if (path.endsWith('/tx') && method === 'POST') return { status: 200, body: 'a'.repeat(64) }
      throw new Error(`Unexpected request ${method} ${path}`)
    }
    const wallet = new BitcoinWallet('https://esplora.example/api', () => null, () => 1_000, requester)
    const address = wallet.address(secret)
    expect(address.startsWith('bc1p')).toBe(true)

    const snapshot = await wallet.snapshot(secret)
    expect(snapshot.balance.available).toBe('0.0005')

    const preview = await wallet.prepareSend(secret, destination, parseBtcAmount('0.0001'))
    expect(preview.amountSats).toBe(10_000)
    expect(preview.feeSats).toBeGreaterThan(0)
    expect(calls.some((call) => call.method === 'POST')).toBe(false)

    const result = await wallet.confirmSend(preview.token)
    expect(result.txid).toBe('a'.repeat(64))
    expect(calls.some((call) => call.method === 'POST' && Boolean(call.body))).toBe(true)
    await expect(wallet.confirmSend(preview.token)).rejects.toThrow(/expired/)
  })

  it('rejects insecure public Esplora URLs', () => {
    expect(() => new BitcoinWallet('http://esplora.example/api')).toThrow(/HTTPS/)
    expect(() => new BitcoinWallet('http://127.0.0.1:3000/api')).not.toThrow()
  })
})
