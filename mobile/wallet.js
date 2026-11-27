import * as btc from '@scure/btc-signer'
import { hex } from '@scure/base'
import QRCode from 'qrcode'
import { parsePaymentQr, scanQr } from './qr-scan.js'
import { MoneroSyncCancelled, MoneroWalletSession, resolveRestoreHeight } from '../src/shared/monero-wallet.ts'
import { DEFAULT_MONERO_DAEMON_URL } from '../src/shared/wallet.ts'
import { createMobileNwc } from './nwc.js'
import { normalizeNwcUri } from '../src/shared/nwc.ts'
import { decodeBolt11Invoice } from '../src/shared/bolt11.ts'

const DEFAULT_ESPLORA = 'https://blockstream.info/api'
const byId = (id) => document.getElementById(id)
let selectedCurrency = 'BTC'
let currentAddress = ''
let currentPublicKey = ''
let pendingPsbt = null
let moneroSession = null
let moneroRecord = null
let moneroDraftSeed = ''
let moneroDraftHeight = 0
let moneroChallengeIndex = 0
let moneroPreview = null
let nwc = null
let nwcPaymentPending = false

async function loadNwc() {
  try {
    const uri = await window.__TAURI__.core.invoke('wallet_nwc_load')
    nwc?.dispose(); nwc = uri ? createMobileNwc(uri) : null
    byId('wallet-nwc-connected').hidden = !nwc
    byId('wallet-nwc-connect-card').hidden = Boolean(nwc)
    byId('wallet-nwc-settings').hidden = !nwc
    if (nwc) {
      const [info, balance] = await Promise.all([nwc.getInfo(), nwc.getBalance()])
      byId('wallet-nwc-status').textContent = `${info.alias || 'Lightning wallet'}${info.network ? ` · ${info.network}` : ''}`
      byId('wallet-nwc-status-detail').textContent = info.alias || 'Nostr Wallet Connect'
      byId('wallet-nwc-balance').textContent = `${(balance.balance / 1000).toLocaleString()} sats`
    } else byId('wallet-nwc-balance').textContent = '— sats'
  } catch (error) {
    byId('wallet-nwc-connect-card').hidden = Boolean(nwc)
    byId('wallet-nwc-connected').hidden = !nwc
    message(error instanceof Error ? error.message : String(error))
  }
}

export async function handleNwcPageRequest(request) {
  if (!nwc) throw new Error('Connect a Lightning wallet in Wallet first')
  switch (request.method) {
    case 'enable': return { enabled: true }
    case 'get_info': return nwc.getInfo()
    case 'get_balance': { const value = await nwc.getBalance(); return { balance: value.balance / 1000 } }
    case 'pay_invoice': {
      const invoice = typeof request.params === 'string' ? request.params : request.params?.paymentRequest
      if (typeof invoice !== 'string' || !invoice) throw new Error('The page did not provide a Lightning invoice')
      const decoded = decodeBolt11Invoice(invoice)
      if (decoded.expired) throw new Error('This Lightning invoice has expired. Request a new invoice.')
      const amount = lightningAmount(decoded.amountMsat)
      if (!window.confirm(`${request.origin} requests a Lightning payment.\n\nAmount: ${amount}\nNetwork: ${decoded.network}\nExpires: ${new Date(decoded.expiresAt * 1000).toLocaleString()}\nDescription: ${decoded.description || (decoded.descriptionHash ? 'Private description' : 'None provided')}\n\nPay this invoice?`)) throw new Error('Payment cancelled')
      return nwc.payInvoice(decoded.invoice)
    }
    case 'make_invoice': {
      const params = request.params || {}
      if (!Number.isSafeInteger(params.amount) || params.amount <= 0) throw new Error('Invoice amount must be a positive number of sats')
      const invoice = await nwc.makeInvoice({ amount: params.amount * 1000, ...(typeof params.defaultMemo === 'string' ? { description: params.defaultMemo } : {}) })
      return { paymentRequest: invoice.invoice, ...invoice }
    }
    default: throw new Error('Unsupported WebLN request')
  }
}

function message(text) { byId('wallet-note').textContent = text }
function lightningAmount(msat) {
  if (msat == null) return 'No fixed amount'
  const value = BigInt(msat)
  return value % 1000n === 0n ? `${(value / 1000n).toLocaleString()} sats` : `${value.toLocaleString()} msat`
}
function parseAmount(input) {
  const value = input.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) throw new Error('Enter a BTC amount with up to 8 decimal places')
  const [whole, fraction = ''] = value.split('.')
  const sats = Number(whole) * 100_000_000 + Number(fraction.padEnd(8, '0'))
  if (!Number.isSafeInteger(sats) || sats < 330) throw new Error('Amount is below the Bitcoin dust limit')
  return sats
}
function btcText(sats) { return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0' }
function btcUrl(path) { return `${getEndpoint()}${path}` }
function getEndpoint() {
  const value = localStorage.getItem('ncc.wallet.esplora') || DEFAULT_ESPLORA
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('Esplora must use HTTPS (HTTP is allowed for localhost)')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Esplora URL cannot include credentials or query parameters')
  return parsed.toString().replace(/\/$/, '')
}
async function api(url, method = 'GET', body) {
  return window.__TAURI__.core.invoke('wallet_http', { url, method, body })
}
async function getBitcoinIdentity() {
  const pubkey = await window.__TAURI__.core.invoke('bitcoin_public_key')
  return { pubkey, payment: btc.p2tr(hex.decode(pubkey)) }
}

function showTransactions(transactions) {
  const container = byId('wallet-transactions')
  container.replaceChildren()
  if (!transactions.length) { container.textContent = 'No Bitcoin transactions found.'; return }
  for (const tx of transactions.slice(0, 30)) {
    const row = document.createElement('div')
    row.className = 'wallet-tx'
    const info = document.createElement('div')
    const id = document.createElement('code')
    id.textContent = `${tx.txid.slice(0, 12)}…${tx.txid.slice(-8)}`
    const detail = document.createElement('small')
    detail.textContent = `${tx.direction} · ${tx.status.confirmed ? 'confirmed' : 'pending'}`
    info.append(id, detail)
    const amount = document.createElement('strong')
    amount.textContent = `${tx.direction === 'incoming' ? '+' : '−'}${btcText(Math.abs(tx.amount))} BTC`
    row.append(info, amount)
    container.append(row)
  }
}

async function readSnapshot() {
  const { pubkey, payment } = await getBitcoinIdentity()
  if (!payment.address) throw new Error('Could not derive the Bitcoin address')
  currentPublicKey = pubkey
  currentAddress = payment.address
  const addressPath = `/address/${encodeURIComponent(currentAddress)}`
  const [stats, txs] = await Promise.all([
    api(btcUrl(addressPath)).then(JSON.parse),
    api(btcUrl(`${addressPath}/txs`)).then(JSON.parse)
  ])
  const confirmed = Math.max(0, stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum)
  const mempool = Math.max(0, stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum)
  byId('wallet-balance').textContent = `${btcText(confirmed + mempool)} BTC`
  byId('wallet-pending').textContent = `Available · ${btcText(mempool)} BTC pending`
  byId('wallet-address').textContent = currentAddress
  // Match the Android wallet's compact receive card. CSS still constrains this
  // to the available viewport if the app is shown in a narrow split window.
  byId('wallet-qr').src = await QRCode.toDataURL(`bitcoin:${currentAddress}`, { width: 188, margin: 1 })
  byId('wallet-qr').hidden = false
  const tip = Number(await api(btcUrl('/blocks/tip/height')).catch(() => '0'))
  showTransactions(Array.isArray(txs) ? txs.map((tx) => {
    const incoming = tx.vout.filter((out) => out.scriptpubkey_address === currentAddress).reduce((sum, out) => sum + out.value, 0)
    const outgoing = tx.vin.filter((input) => input.prevout?.scriptpubkey_address === currentAddress).reduce((sum, input) => sum + (input.prevout?.value ?? 0), 0)
    const net = incoming - outgoing
    return { ...tx, direction: net > 0 ? 'incoming' : 'outgoing', amount: Math.abs(net), confirmations: tx.status.confirmed ? Math.max(1, tip - Number(tx.status.block_height ?? tip) + 1) : 0 }
  }) : [])
}

export async function loadWallet() {
  if (selectedCurrency === 'LN') {
    byId('wallet-open-identity').hidden = true
    message('')
    await loadNwc()
    return
  }
  byId('wallet-esplora').value = localStorage.getItem('ncc.wallet.esplora') || DEFAULT_ESPLORA
  byId('wallet-open-identity').hidden = true
  byId('wallet-xmr-note').textContent = ''
  message('')
  if (selectedCurrency === 'XMR') { await loadMoneroWallet(); return }
  await closeMoneroWallet()
  byId('wallet-note').textContent = 'Loading Bitcoin wallet…'
  byId('wallet-qr').hidden = true
  try { await getBitcoinIdentity() }
  catch {
    byId('wallet-open-identity').hidden = false
    message('Wallet access follows your identity lock. There is no separate wallet password.')
    return
  }
  try { await readSnapshot(); message('') }
  catch (error) { message(error instanceof Error ? error.message : String(error)) }
}

export async function closeMoneroWallet() {
  // A scan carries on, saving as it goes, and opening the wallet again rejoins it.
  moneroSession?.release()
  moneroRecord = null
  moneroPreview = null
}

async function loadMoneroWallet() {
  if (!moneroSession) moneroSession = new MoneroWalletSession()
  const daemon = localStorage.getItem('ncc.wallet.monero-daemon') || DEFAULT_MONERO_DAEMON_URL
  byId('wallet-xmr-daemon').value = daemon
  let timer = null
  try {
    try { await window.__TAURI__.core.invoke('bitcoin_public_key') }
    catch {
      byId('wallet-xmr-create').disabled = true
      byId('wallet-xmr-restore').disabled = true
      byId('wallet-open-identity').hidden = false
      message('Wallet access follows your identity lock. There is no separate wallet password.')
      return
    }
    byId('wallet-open-identity').hidden = true
    byId('wallet-xmr-create').disabled = false
    byId('wallet-xmr-restore').disabled = false
    moneroRecord = await window.__TAURI__.core.invoke('wallet_monero_load')
    if (!moneroRecord) { byId('wallet-xmr-setup').hidden = false; byId('wallet-xmr-receive').hidden = true; return }
    byId('wallet-xmr-setup').hidden = true; byId('wallet-xmr-backup').hidden = true; byId('wallet-xmr-receive').hidden = false
    let phase = 'Loading Monero engine…'
    let shown = null
    const showProgress = () => {
      // Balance and transactions found so far, as of the latest checkpoint.
      const latest = moneroSession.lastSnapshot
      if (latest && latest !== shown) { shown = latest; void renderMoneroSnapshot(latest).catch(() => undefined) }
      const { height, endHeight, percent } = moneroSession.progress
      byId('wallet-xmr-note').textContent = phase
        || (endHeight > 0
          ? `Scanning block ${height.toLocaleString()} of ${endHeight.toLocaleString()} (${percent.toFixed(percent < 10 ? 1 : 0)}%).`
          : 'Connecting to the Monero node…')
    }
    timer = window.setInterval(() => showProgress(), 1000)
    showProgress()
    // Show the address, QR code and any cached balance straight away while the scan catches up.
    shown = await moneroSession.open(moneroOpenOptions(moneroRecord, byId('wallet-xmr-daemon').value))
    await renderMoneroSnapshot(shown).catch(() => undefined)
    phase = ''; showProgress()
    await renderMoneroSnapshot(await moneroSession.sync(saveMoneroCache))
    byId('wallet-xmr-note').textContent = moneroSession.saveError ? `Monero wallet is synced, but the scan could not be saved: ${moneroSession.saveError}` : 'Monero wallet is synced.'
  } catch (error) { if (!(error instanceof MoneroSyncCancelled)) byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  finally { if (timer) window.clearInterval(timer) }
}

async function renderMoneroSnapshot(snapshot) {
  byId('wallet-xmr-balance').textContent = snapshot.balance
  byId('wallet-xmr-unlocked').textContent = snapshot.unlocked
  byId('wallet-xmr-address').textContent = snapshot.address
  byId('wallet-xmr-qr').src = await QRCode.toDataURL(`monero:${snapshot.address}`, { width: 300, margin: 1 })
  byId('wallet-xmr-qr').hidden = false
  const list = byId('wallet-xmr-transactions'); list.replaceChildren()
  if (!snapshot.transactions.length) { list.textContent = 'No Monero transactions found.'; return }
  for (const tx of snapshot.transactions) {
    const row = document.createElement('div'); row.className = 'wallet-tx'
    const info = document.createElement('div'); const id = document.createElement('code'); id.textContent = `${tx.id.slice(0, 12)}…${tx.id.slice(-8)}`
    const detail = document.createElement('small'); detail.textContent = `${tx.direction} · ${tx.status} · ${tx.confirmations} confirmations`; info.append(id, detail)
    const amount = document.createElement('strong'); amount.textContent = `${tx.direction === 'incoming' ? '+' : '−'}${tx.amount} XMR`; row.append(info, amount); list.append(row)
  }
}

function moneroOpenOptions(record, daemonUrl) {
  return { seed: record.seed, daemonUrl, restoreHeight: record.restoreHeight, address: record.address, loadWalletData: () => window.__TAURI__.core.invoke('wallet_monero_cache_load') }
}

async function saveMoneroCache(data) {
  await window.__TAURI__.core.invoke('wallet_monero_cache_save', { data })
}

function startMoneroBackup(seed, restoreHeight) {
  moneroDraftSeed = seed
  moneroDraftHeight = restoreHeight
  byId('wallet-xmr-restore-date').value = ''
  byId('wallet-xmr-restore-height').value = ''
  const words = seed.trim().split(/\s+/)
  moneroChallengeIndex = Math.floor(Math.random() * words.length)
  byId('wallet-xmr-words').replaceChildren(...words.map((word) => { const li = document.createElement('li'); li.textContent = word; return li }))
  byId('wallet-xmr-word-number').textContent = String(moneroChallengeIndex + 1)
  byId('wallet-xmr-word-answer').value = ''
  byId('wallet-xmr-restore-seed').value = ''
  byId('wallet-xmr-backup').hidden = false
  byId('wallet-xmr-setup').hidden = true
}

async function saveMoneroBackup() {
  const words = moneroDraftSeed.trim().split(/\s+/)
  if (byId('wallet-xmr-word-answer').value.trim().toLowerCase() !== words[moneroChallengeIndex]?.toLowerCase()) {
    byId('wallet-xmr-note').textContent = `Word ${moneroChallengeIndex + 1} does not match. Check your written seed.`; return
  }
  try {
    message('Verifying the wallet address offline…')
    const daemonUrl = byId('wallet-xmr-daemon').value.trim()
    const address = await moneroSession.deriveAddress(moneroDraftSeed)
    moneroRecord = { version: 1, seed: moneroDraftSeed, address, restoreHeight: moneroDraftHeight, backupConfirmed: true, syncChoice: byId('wallet-xmr-sync').value }
    await window.__TAURI__.core.invoke('wallet_monero_save', { record: moneroRecord })
    localStorage.setItem('ncc.wallet.monero-daemon', daemonUrl)
    moneroDraftSeed = ''; byId('wallet-xmr-backup').hidden = true; byId('wallet-xmr-receive').hidden = false
    byId('wallet-xmr-words').replaceChildren(); byId('wallet-xmr-word-answer').value = ''
    message('')
    // The same path as reopening, so the first scan shows its progress too.
    await loadMoneroWallet()
  } catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
}

async function prepareSend() {
  const amount = parseAmount(byId('wallet-send-amount').value)
  const destination = byId('wallet-send-address').value.trim()
  const { payment } = await getBitcoinIdentity()
  const [utxos, feeEstimates] = await Promise.all([
    api(btcUrl(`/address/${encodeURIComponent(payment.address)}/utxo`)).then(JSON.parse),
    api(btcUrl('/fee-estimates')).then(JSON.parse)
  ])
  const rate = Math.max(1, Math.ceil(Number(feeEstimates['3'] ?? feeEstimates['6'] ?? 2)))
  const candidates = utxos.filter((utxo) => utxo.status.confirmed && utxo.value > 0).sort((a, b) => b.value - a.value)
  if (!candidates.length) throw new Error('No confirmed Bitcoin outputs are available to spend')
  const tx = new btc.Transaction()
  let total = 0
  for (const utxo of candidates) {
    tx.addInput({ ...payment, txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) } })
    total += utxo.value
    if (total >= amount + Math.ceil((150 + tx.inputsLength * 58) * rate)) break
  }
  const estimatedFee = Math.ceil((150 + tx.inputsLength * 58) * rate)
  if (total < amount + estimatedFee) throw new Error('Bitcoin balance is too low to cover the amount and network fee')
  tx.addOutputAddress(destination, BigInt(amount))
  const change = total - amount - estimatedFee
  if (change > 330) tx.addOutputAddress(payment.address, BigInt(change))
  const fee = total - amount - (change > 330 ? change : 0)
  pendingPsbt = hex.encode(tx.toPSBT())
  byId('wallet-send-preview').innerHTML = ''
  for (const line of [`To: ${destination}`, `Amount: ${amount.toLocaleString()} sats`, `Network fee: ${fee.toLocaleString()} sats`, `Total: ${(amount + fee).toLocaleString()} sats`, 'Transactions are irreversible. Verify the address carefully.']) {
    const p = document.createElement('p'); p.textContent = line; byId('wallet-send-preview').append(p)
  }
  byId('wallet-send-preview').hidden = false
  byId('wallet-send-review').hidden = true
  byId('wallet-send-confirm').hidden = false
}

async function confirmSend() {
  if (!pendingPsbt) return
  const signed = await window.__TAURI__.core.invoke('bitcoin_sign_psbt', { psbtHex: pendingPsbt })
  const tx = btc.Transaction.fromPSBT(hex.decode(signed))
  tx.finalize()
  const txid = (await api(btcUrl('/tx'), 'POST', tx.hex)).trim()
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Bitcoin service returned an invalid transaction id')
  pendingPsbt = null
  byId('wallet-send').hidden = true
  byId('wallet-send-preview').hidden = true
  byId('wallet-send-confirm').hidden = true
  byId('wallet-send-review').hidden = false
  byId('wallet-send-address').value = ''
  byId('wallet-send-amount').value = ''
  message(`Broadcast. Transaction ${txid.slice(0, 12)}…${txid.slice(-8)}`)
  await loadWallet()
}

export function wireWallet() {
  void loadNwc()
  byId('wallet-refresh').addEventListener('click', () => void loadWallet())
  byId('wallet-nwc-connect').addEventListener('click', async () => {
    try {
      // Saved tidied: the Android side only stores the exact nostr+walletconnect:// form.
      const uri = normalizeNwcUri(byId('wallet-nwc-uri').value)
      const next = createMobileNwc(uri)
      const info = await next.getInfo()
      await window.__TAURI__.core.invoke('wallet_nwc_save', { uri })
      nwc?.dispose(); nwc = next; byId('wallet-nwc-uri').value = ''
      await loadNwc()
      message(`${info.alias || 'Lightning wallet'} connected.`)
    } catch (error) { message(error instanceof Error ? error.message : String(error)) }
  })
  byId('wallet-nwc-reveal').addEventListener('click', () => {
    const input = byId('wallet-nwc-uri')
    const visible = input.type === 'password'
    input.type = visible ? 'text' : 'password'
    byId('wallet-nwc-reveal').textContent = visible ? 'Hide connection URI' : 'Reveal connection URI'
    byId('wallet-nwc-reveal').setAttribute('aria-pressed', String(visible))
  })
  byId('wallet-nwc-disconnect').addEventListener('click', async () => {
    await window.__TAURI__.core.invoke('wallet_nwc_delete'); nwc?.dispose(); nwc = null
    byId('wallet-nwc-connected').hidden = true; byId('wallet-nwc-settings').hidden = true; byId('wallet-nwc-connect-card').hidden = false
    byId('wallet-nwc-receive-view').hidden = true; byId('wallet-nwc-send').hidden = true
  })
  byId('wallet-nwc-open-send').addEventListener('click', () => { byId('wallet-nwc-send').hidden = false; byId('wallet-nwc-send-entry').hidden = false; byId('wallet-nwc-send-preview').hidden = true; byId('wallet-nwc-send-error').hidden = true; byId('wallet-nwc-confirm').hidden = true; byId('wallet-nwc-pay').hidden = false; byId('wallet-nwc-invoice').focus() })
  byId('wallet-nwc-cancel-send').addEventListener('click', () => { byId('wallet-nwc-send').hidden = true; byId('wallet-nwc-invoice').value = ''; byId('wallet-nwc-send-preview').hidden = true; byId('wallet-nwc-send-error').hidden = true })
  byId('wallet-nwc-pay').addEventListener('click', () => {
    try {
      const decoded = decodeBolt11Invoice(byId('wallet-nwc-invoice').value)
      if (decoded.expired) throw new Error('This Lightning invoice has expired. Request a new invoice.')
      const amount = lightningAmount(decoded.amountMsat)
      const preview = byId('wallet-nwc-send-preview'); preview.replaceChildren()
      for (const [key, value] of [['Amount', amount], ['Network', decoded.network], ['Expires', new Date(decoded.expiresAt * 1000).toLocaleString()], ['Description', decoded.description || (decoded.descriptionHash ? 'Private description (hash only)' : 'None provided')]]) {
        const row = document.createElement('p'); row.textContent = `${key}: ${value}`; preview.append(row)
      }
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Show invoice'; const raw = document.createElement('code'); raw.className = 'wallet-raw-invoice'; raw.textContent = decoded.invoice; details.append(summary, raw); preview.append(details)
      preview.hidden = false; byId('wallet-nwc-send-entry').hidden = true; byId('wallet-nwc-pay').hidden = true; byId('wallet-nwc-confirm').hidden = false
      byId('wallet-nwc-send-error').hidden = true
    } catch (error) { const text = error instanceof Error ? error.message : String(error); byId('wallet-nwc-send-error').textContent = text; byId('wallet-nwc-send-error').hidden = false; message(text) }
  })
  byId('wallet-nwc-confirm').addEventListener('click', async () => {
    if (nwcPaymentPending) return
    try {
      const decoded = decodeBolt11Invoice(byId('wallet-nwc-invoice').value)
      if (decoded.expired) throw new Error('This Lightning invoice has expired. Request a new invoice.')
      nwcPaymentPending = true; byId('wallet-nwc-confirm').disabled = true; byId('wallet-nwc-confirm').textContent = 'Sending…'
      await nwc.payInvoice(decoded.invoice); byId('wallet-nwc-invoice').value = ''; byId('wallet-nwc-send').hidden = true; byId('wallet-nwc-send-preview').hidden = true; message('Lightning payment sent.')
      await loadNwc()
    } catch (error) { const text = error instanceof Error ? error.message : String(error); byId('wallet-nwc-send-error').textContent = text; byId('wallet-nwc-send-error').hidden = false; message(text) }
    finally { nwcPaymentPending = false; byId('wallet-nwc-confirm').disabled = false; byId('wallet-nwc-confirm').textContent = 'Confirm and pay' }
  })
  byId('wallet-nwc-receive').addEventListener('click', () => {
    byId('wallet-nwc-receive-entry').hidden = false; byId('wallet-nwc-receive-view').hidden = true; byId('wallet-nwc-receive-error').hidden = true; byId('wallet-nwc-amount').value = ''; byId('wallet-nwc-amount').focus()
  })
  byId('wallet-nwc-cancel-receive').addEventListener('click', () => { byId('wallet-nwc-receive-entry').hidden = true })
  byId('wallet-nwc-create-invoice').addEventListener('click', async () => {
    const create = byId('wallet-nwc-create-invoice')
    try {
      const sats = Number(byId('wallet-nwc-amount').value)
      if (!Number.isSafeInteger(sats) || sats <= 0 || sats > Number.MAX_SAFE_INTEGER / 1000) throw new Error('Enter a positive whole amount in sats.')
      create.disabled = true; create.textContent = 'Creating…'
      const result = await nwc.makeInvoice({ amount: sats * 1000 })
      byId('wallet-nwc-created').textContent = result.invoice
      byId('wallet-nwc-created').onclick = async () => { try { await navigator.clipboard.writeText(result.invoice); message('Invoice copied.') } catch { message('Could not copy invoice.') } }
      byId('wallet-nwc-qr').src = await QRCode.toDataURL(`lightning:${result.invoice}`, { width: 220, margin: 1 })
      let expiryText = ''
      try { expiryText = ` · expires ${new Date(decodeBolt11Invoice(result.invoice).expiresAt * 1000).toLocaleString()}` } catch { /* Keep the generated invoice usable if its wallet omits decodable metadata. */ }
      byId('wallet-nwc-receive-amount').textContent = `Requesting ${sats.toLocaleString()} sats${expiryText}`
      byId('wallet-nwc-qr').hidden = false; byId('wallet-nwc-receive-entry').hidden = true; byId('wallet-nwc-receive-view').hidden = false
    } catch (error) { const text = error instanceof Error ? error.message : String(error); byId('wallet-nwc-receive-error').textContent = text; byId('wallet-nwc-receive-error').hidden = false; message(text) }
    finally { create.disabled = false; create.textContent = 'Create invoice' }
  })
  byId('wallet-copy-address').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentAddress); message('Address copied.') }
    catch { message('Could not copy the address.') }
  })
  byId('wallet-save-esplora').addEventListener('click', () => {
    try { getEndpoint(); localStorage.setItem('ncc.wallet.esplora', byId('wallet-esplora').value.trim().replace(/\/$/, '')); void loadWallet() }
    catch (error) { message(error instanceof Error ? error.message : String(error)) }
  })
  document.querySelectorAll('.wallet-scan').forEach((button) => button.addEventListener('click', async () => {
    const input = byId(button.dataset.scanTarget)
    const isMonero = button.dataset.scanTarget.includes('xmr')
    const text = await scanQr()
    if (!text) return
    if (button.dataset.scanTarget === 'wallet-nwc-invoice') {
      input.value = text.trim().replace(/^lightning:/i, '')
      message('Lightning invoice scanned.')
      return
    }
    const { address, amount } = parsePaymentQr(text, isMonero ? 'monero' : 'bitcoin')
    input.value = address
    const amountInput = byId(isMonero ? 'wallet-xmr-send-amount' : 'wallet-send-amount')
    if (amount && !amountInput.value) amountInput.value = amount
  }))
  byId('wallet-open-send').addEventListener('click', () => { byId('wallet-send').hidden = false; byId('wallet-send-address').focus() })
  byId('wallet-send-cancel').addEventListener('click', () => {
    pendingPsbt = null; byId('wallet-send').hidden = true; byId('wallet-send-preview').hidden = true
    byId('wallet-send-confirm').hidden = true; byId('wallet-send-review').hidden = false
  })
  byId('wallet-send-review').addEventListener('click', async () => {
    try { message('Building transaction preview…'); await prepareSend(); message('Review the destination and fee, then confirm to broadcast.') }
    catch (error) { message(error instanceof Error ? error.message : String(error)) }
  })
  byId('wallet-send-confirm').addEventListener('click', async () => {
    try { message('Signing and broadcasting…'); await confirmSend() }
    catch (error) { message(error instanceof Error ? error.message : String(error)) }
  })
  for (const button of document.querySelectorAll('[data-currency]')) {
    button.addEventListener('click', () => {
      selectedCurrency = button.dataset.currency
      for (const item of document.querySelectorAll('[data-currency]')) {
        item.classList.toggle('selected', item === button)
        item.setAttribute('aria-pressed', String(item === button))
      }
      byId('wallet-bitcoin').hidden = selectedCurrency !== 'BTC'
      byId('wallet-monero').hidden = selectedCurrency !== 'XMR'
      byId('wallet-lightning').hidden = selectedCurrency !== 'LN'
      void loadWallet()
    })
  }

  const xmr = (id, event, handler) => byId(id).addEventListener(event, handler)
  xmr('wallet-xmr-create', 'click', async () => {
    try { const generated = await moneroSession.create(byId('wallet-xmr-daemon').value.trim()); startMoneroBackup(generated.seed, generated.restoreHeight) }
    catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  })
  xmr('wallet-xmr-restore', 'click', () => {
    const seed = byId('wallet-xmr-restore-seed').value.trim()
    if (seed.split(/\s+/).length !== 25) { byId('wallet-xmr-note').textContent = 'Enter all 25 words of your Monero recovery seed.'; return }
    try { startMoneroBackup(seed, resolveRestoreHeight({ date: byId('wallet-xmr-restore-date').value, height: byId('wallet-xmr-restore-height').value })) }
    catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error); return }
    byId('wallet-xmr-note').textContent = ''
  })
  xmr('wallet-xmr-backup-confirm', 'click', () => void saveMoneroBackup())
  xmr('wallet-xmr-refresh', 'click', () => void loadMoneroWallet())
  xmr('wallet-xmr-copy', 'click', async () => { try { await navigator.clipboard.writeText(byId('wallet-xmr-address').textContent); byId('wallet-xmr-note').textContent = 'Address copied.' } catch { byId('wallet-xmr-note').textContent = 'Could not copy address.' } })
  xmr('wallet-xmr-open-send', 'click', () => { byId('wallet-xmr-send').hidden = false; byId('wallet-xmr-send-address').focus() })
  xmr('wallet-xmr-send-cancel', 'click', () => { moneroPreview = null; byId('wallet-xmr-send').hidden = true; byId('wallet-xmr-send-preview').hidden = true; byId('wallet-xmr-send-confirm').hidden = true; byId('wallet-xmr-send-review').hidden = false })
  xmr('wallet-xmr-send-review', 'click', async () => {
    try {
      const preview = await moneroSession.prepareSend(byId('wallet-xmr-send-address').value, byId('wallet-xmr-send-amount').value)
      moneroPreview = preview
      const box = byId('wallet-xmr-send-preview'); box.replaceChildren()
      for (const line of [`To: ${preview.address}`, `Amount: ${preview.amount} XMR`, `Fee: ${preview.fee} XMR`, `Transactions: ${preview.transactions}`, 'This transfer cannot be reversed.']) { const p = document.createElement('p'); p.textContent = line; box.append(p) }
      box.hidden = false; byId('wallet-xmr-send-review').hidden = true; byId('wallet-xmr-send-confirm').hidden = false
    } catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  })
  xmr('wallet-xmr-send-confirm', 'click', async () => {
    if (!moneroPreview) return
    try { const ids = await moneroSession.confirmSend(moneroPreview.id); void moneroSession.exportWalletData().then(saveMoneroCache).catch(() => undefined); byId('wallet-xmr-note').textContent = `Broadcast ${ids.length} Monero transaction${ids.length === 1 ? '' : 's'}.`; moneroPreview = null; byId('wallet-xmr-send').hidden = true; await renderMoneroSnapshot(await moneroSession.snapshot()) }
    catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  })
}
