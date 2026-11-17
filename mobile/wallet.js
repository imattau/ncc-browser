import * as btc from '@scure/btc-signer'
import { hex } from '@scure/base'
import QRCode from 'qrcode'
import { MoneroWalletSession } from '../src/shared/monero-wallet.ts'
import { DEFAULT_MONERO_DAEMON_URL } from '../src/shared/wallet.ts'

const DEFAULT_ESPLORA = 'https://blockstream.info/api'
const byId = (id) => document.getElementById(id)
let selectedCurrency = 'BTC'
let currentAddress = ''
let currentPublicKey = ''
let pendingPsbt = null
let moneroSession = null
let moneroRecord = null
let moneroDraftSeed = ''
let moneroChallengeIndex = 0
let moneroPreview = null

function message(text) { byId('wallet-note').textContent = text }
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
  byId('wallet-pending').textContent = `Pending: ${btcText(mempool)} BTC`
  byId('wallet-address').textContent = currentAddress
  byId('wallet-qr').src = await QRCode.toDataURL(`bitcoin:${currentAddress}`, { width: 200, margin: 1 })
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
  byId('wallet-esplora').value = localStorage.getItem('ncc.wallet.esplora') || DEFAULT_ESPLORA
  byId('wallet-open-identity').hidden = true
  if (selectedCurrency === 'XMR') { await loadMoneroWallet(); return }
  await closeMoneroWallet()
  byId('wallet-note').textContent = 'Loading Bitcoin wallet…'
  byId('wallet-qr').hidden = true
  try { await getBitcoinIdentity() }
  catch {
    byId('wallet-open-identity').hidden = false
    message('Wallets use your unlocked local Nostr identity; there is no separate wallet password. Set up or unlock your identity to continue.')
    return
  }
  try { await readSnapshot(); message('') }
  catch (error) { message(error instanceof Error ? error.message : String(error)) }
}

export async function closeMoneroWallet() {
  if (moneroSession) await moneroSession.close()
  moneroSession = null
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
      byId('wallet-xmr-note').textContent = 'Monero opens with your unlocked local Nostr identity; there is no separate wallet password.'
      return
    }
    byId('wallet-open-identity').hidden = true
    byId('wallet-xmr-create').disabled = false
    byId('wallet-xmr-restore').disabled = false
    moneroRecord = await window.__TAURI__.core.invoke('wallet_monero_load')
    if (!moneroRecord) { byId('wallet-xmr-setup').hidden = false; byId('wallet-xmr-receive').hidden = true; return }
    byId('wallet-xmr-setup').hidden = true; byId('wallet-xmr-backup').hidden = true; byId('wallet-xmr-receive').hidden = false
    message('Opening Monero wallet and scanning locally. First sync can take a while.')
    timer = window.setInterval(() => { byId('wallet-xmr-note').textContent = `Scanning block ${moneroSession.progress.height.toLocaleString()} (${Math.floor(moneroSession.progress.percent)}%).` }, 1000)
    await moneroSession.open({ seed: moneroRecord.seed, daemonUrl: byId('wallet-xmr-daemon').value, restoreHeight: moneroRecord.restoreHeight })
    await renderMoneroSnapshot(await moneroSession.sync())
    byId('wallet-xmr-note').textContent = 'Monero wallet is synced.'
  } catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  finally { if (timer) window.clearInterval(timer) }
}

async function renderMoneroSnapshot(snapshot) {
  byId('wallet-xmr-balance').textContent = snapshot.balance
  byId('wallet-xmr-unlocked').textContent = snapshot.unlocked
  byId('wallet-xmr-address').textContent = snapshot.address
  byId('wallet-xmr-qr').src = await QRCode.toDataURL(`monero:${snapshot.address}`, { width: 200, margin: 1 })
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

function startMoneroBackup(seed) {
  moneroDraftSeed = seed
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
    moneroRecord = { version: 1, seed: moneroDraftSeed, address, restoreHeight: Number(byId('wallet-xmr-restore-height').value), backupConfirmed: true, syncChoice: byId('wallet-xmr-sync').value }
    await window.__TAURI__.core.invoke('wallet_monero_save', { record: moneroRecord })
    localStorage.setItem('ncc.wallet.monero-daemon', daemonUrl)
    moneroDraftSeed = ''; byId('wallet-xmr-backup').hidden = true; byId('wallet-xmr-receive').hidden = false
    byId('wallet-xmr-words').replaceChildren(); byId('wallet-xmr-word-answer').value = ''
    await moneroSession.open({ seed: moneroRecord.seed, daemonUrl, restoreHeight: moneroRecord.restoreHeight })
    await renderMoneroSnapshot(await moneroSession.sync()); byId('wallet-xmr-note').textContent = 'Backup checked. Monero wallet is synced.'
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
  byId('wallet-refresh').addEventListener('click', () => void loadWallet())
  byId('wallet-copy-address').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentAddress); message('Address copied.') }
    catch { message('Could not copy the address.') }
  })
  byId('wallet-save-esplora').addEventListener('click', () => {
    try { getEndpoint(); localStorage.setItem('ncc.wallet.esplora', byId('wallet-esplora').value.trim().replace(/\/$/, '')); void loadWallet() }
    catch (error) { message(error instanceof Error ? error.message : String(error)) }
  })
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
    if (!window.confirm('Send this Bitcoin transaction now? This cannot be reversed.')) return
    try { message('Signing and broadcasting…'); await confirmSend() }
    catch (error) { message(error instanceof Error ? error.message : String(error)) }
  })
  for (const button of document.querySelectorAll('[data-currency]')) {
    button.addEventListener('click', () => {
      selectedCurrency = button.dataset.currency
      for (const item of document.querySelectorAll('[data-currency]')) item.classList.toggle('selected', item === button)
      byId('wallet-bitcoin').hidden = selectedCurrency !== 'BTC'
      byId('wallet-monero').hidden = selectedCurrency !== 'XMR'
      void loadWallet()
    })
  }

  const xmr = (id, event, handler) => byId(id).addEventListener(event, handler)
  xmr('wallet-xmr-create', 'click', async () => {
    try { const generated = await moneroSession.create(byId('wallet-xmr-daemon').value.trim()); byId('wallet-xmr-restore-height').value = String(generated.restoreHeight); startMoneroBackup(generated.seed) }
    catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  })
  xmr('wallet-xmr-restore', 'click', () => {
    const seed = byId('wallet-xmr-restore-seed').value.trim()
    if (seed.split(/\s+/).length !== 25) { byId('wallet-xmr-note').textContent = 'Enter all 25 words of your Monero recovery seed.'; return }
    startMoneroBackup(seed)
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
    if (!moneroPreview || !window.confirm('Send this Monero transaction now? This cannot be reversed.')) return
    try { const ids = await moneroSession.confirmSend(moneroPreview.id); byId('wallet-xmr-note').textContent = `Broadcast ${ids.length} Monero transaction${ids.length === 1 ? '' : 's'}.`; moneroPreview = null; byId('wallet-xmr-send').hidden = true; await renderMoneroSnapshot(await moneroSession.snapshot()) }
    catch (error) { byId('wallet-xmr-note').textContent = error instanceof Error ? error.message : String(error) }
  })
}
