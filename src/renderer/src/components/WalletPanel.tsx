import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { ArrowUpFromLine, Copy, RefreshCw, X } from 'lucide-react'
import type { BitcoinSendPreview, WalletSnapshot } from '@shared/wallet'
import { MoneroWalletPanel } from './MoneroWalletPanel'

type Props = { onClose: () => void; onOpenIdentitySettings: () => void }
type Settings = { esploraUrl: string; privacyNotice: string }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function shortId(id: string): string { return `${id.slice(0, 12)}…${id.slice(-8)}` }

export function WalletPanel({ onClose, onOpenIdentitySettings }: Props) {
  const [currency, setCurrency] = useState<'BTC' | 'XMR'>('BTC')
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [sendOpen, setSendOpen] = useState(false)
  const [sendAddress, setSendAddress] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [preview, setPreview] = useState<BitcoinSendPreview | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [endpoint, setEndpoint] = useState('')

  const receiveAddress = useMemo(() => snapshot?.receive.find((item) => item.currency === currency)?.address ?? '', [snapshot, currency])

  async function refresh() {
    setBusy(true)
    setMessage('')
    try {
      const [next, prefs] = await Promise.all([window.ncc.walletSnapshot(), window.ncc.walletSettings()])
      setSnapshot(next)
      setSettings(prefs)
      setEndpoint(prefs.esploraUrl)
    } catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!receiveAddress) { setQr(''); return }
    void QRCode.toDataURL(`bitcoin:${receiveAddress}`, { width: 300, margin: 1, color: { dark: '#101418', light: '#ffffff' } })
      .then(setQr).catch((error: unknown) => setMessage(errorText(error)))
  }, [receiveAddress])

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage('Copied to clipboard.') }
    catch { setMessage('Could not copy to clipboard.') }
  }

  async function prepare() {
    setBusy(true); setMessage('')
    try { setPreview(await window.ncc.walletPrepareBitcoinSend(sendAddress, sendAmount)) }
    catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }

  async function confirm() {
    if (!preview) return
    setBusy(true); setMessage('')
    try {
      const result = await window.ncc.walletConfirmBitcoinSend(preview.token)
      setPreview(null); setSendOpen(false); setSendAddress(''); setSendAmount('')
      setMessage(`Broadcast. Transaction ${shortId(result.txid)}`)
      await refresh()
    } catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }

  async function saveSettings() {
    setBusy(true)
    try { setSettings(await window.ncc.walletSetSettings({ esploraUrl: endpoint })); setPrefsOpen(false); await refresh() }
    catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }

  return (
    <section className="absolute inset-0 z-[80] overflow-y-auto bg-[color:var(--color-panel)] text-[color:var(--color-text-strong)]" aria-label="Wallet">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-5 py-4">
        <div><p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">Nostr Navigator</p><h1 className="text-ui-18 font-semibold">Wallet</h1></div>
        <div className="flex gap-2"><button className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]" title="Refresh" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button><button className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]" aria-label="Close wallet" onClick={onClose}><X className="h-4 w-4" /></button></div>
      </header>
      <div className="mx-auto max-w-xl space-y-5 px-5 py-6">
        <nav className="mx-auto flex w-fit rounded-full border border-[color:var(--color-line)] p-1" aria-label="Wallet currency">
          {(['BTC', 'XMR'] as const).map((item) => <button key={item} className={`rounded-full px-5 py-2 text-ui-12 ${currency === item ? 'bg-[color:var(--color-hover)] text-[color:var(--color-text-strong)]' : 'text-[color:var(--color-muted)]'}`} onClick={() => setCurrency(item)}>{item === 'BTC' ? '₿  Bitcoin' : '◉  Monero'}</button>)}
        </nav>
        {currency === 'BTC' ? <>
          <section className="wallet-simple-view">
            <div className="wallet-simple-balance"><p>{snapshot?.balances.find((item) => item.currency === 'BTC')?.available ?? '—'} BTC</p><span>Available{snapshot ? ` · ${snapshot.balances.find((item) => item.currency === 'BTC')?.pending ?? '0'} BTC pending` : ''}</span></div>
            <button disabled={!snapshot?.status.bitcoinAvailable || busy} className="wallet-primary-send" onClick={() => { setSendOpen(true); setPreview(null) }}><ArrowUpFromLine className="h-4 w-4" />Send</button>
            {snapshot?.status.bitcoinAddress ? <div className="wallet-receive-simple">{qr ? <img src={qr} alt="QR code for Bitcoin receive address" className="wallet-receive-qr" /> : null}<button className="wallet-address-pill" onClick={() => void copy(snapshot.status.bitcoinAddress!)}><span>{shortId(snapshot.status.bitcoinAddress)}</span><Copy className="h-4 w-4 shrink-0" /></button></div> : <div className="mt-6 text-center text-ui-11 text-[color:var(--color-muted)]"><p>{snapshot?.status.identityReady === false ? 'Unlock your identity to access this wallet.' : snapshot?.status.error ?? 'Loading wallet…'}</p>{snapshot?.status.identityReady === false ? <button className="mt-3 rounded-lg border border-[color:var(--color-line)] px-3 py-2" onClick={onOpenIdentitySettings}>Set up or unlock identity</button> : null}</div>}
          </section>
          <details className="wallet-transactions-simple"><summary>Transactions <span>⌄</span></summary>
            {snapshot?.transactions.filter((tx) => tx.currency === 'BTC').length ? <ul className="mt-3 divide-y divide-[color:var(--color-line)]">{snapshot.transactions.filter((tx) => tx.currency === 'BTC').map((tx) => <li key={tx.id} className="flex items-center justify-between gap-3 py-3"><div><p className="font-mono text-ui-11">{shortId(tx.id)}</p><p className="text-ui-10 text-[color:var(--color-muted)]">{tx.direction} · {tx.status} · {tx.confirmations} confirmations</p></div><span className="font-mono text-ui-11">{tx.direction === 'incoming' ? '+' : '−'}{tx.amount} BTC</span></li>)}</ul> : <p className="py-5 text-center text-ui-11 text-[color:var(--color-muted)]">{busy ? 'Loading…' : 'No transactions yet.'}</p>}
          </details>
        </> : <MoneroWalletPanel onOpenIdentitySettings={onOpenIdentitySettings} />}
        {message ? <p role="status" className="rounded-lg border border-[color:var(--color-line)] p-3 text-ui-11">{message}</p> : null}
        {currency === 'BTC' && settings ? <details className="text-center text-ui-10 text-[color:var(--color-muted)]"><summary className="cursor-pointer">Network and privacy</summary><p className="mt-2">Bitcoin data service: {settings.esploraUrl}. {settings.privacyNotice}</p><button className="mt-2 underline" onClick={() => setPrefsOpen(true)}>Change service</button></details> : null}
      </div>

      {sendOpen ? <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"><div role="dialog" aria-modal="true" aria-labelledby="btc-send-title" className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"><h2 id="btc-send-title" className="text-ui-16 font-semibold">Send Bitcoin</h2>{preview ? <><p className="mt-4 break-all font-mono text-ui-11">To: {preview.address}</p><p className="mt-3 text-ui-12">Amount: {preview.amountSats.toLocaleString()} sats</p><p className="mt-1 text-ui-12">Network fee: {preview.feeSats.toLocaleString()} sats</p><p className="mt-1 text-ui-12 font-semibold">Total: {preview.totalSats.toLocaleString()} sats</p><p className="mt-3 text-ui-10 text-[color:var(--color-muted)]">This transaction is irreversible. Review the address and amount carefully.</p></> : <div className="mt-4 space-y-3"><label className="block text-ui-11">Destination address<input autoFocus className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-11" value={sendAddress} onChange={(event) => setSendAddress(event.target.value)} /></label><label className="block text-ui-11">Amount in BTC<input inputMode="decimal" className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-11" value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} /></label></div>}<div className="mt-5 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => { setSendOpen(false); setPreview(null) }}>Cancel</button>{preview ? <button disabled={busy} className="rounded-lg bg-[color:var(--color-danger)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void confirm()}>Confirm and send</button> : <button disabled={busy || !sendAddress || !sendAmount} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void prepare()}>Review fee</button>}</div></div></div> : null}

      {prefsOpen ? <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"><div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5"><h2 className="text-ui-15 font-semibold">Bitcoin data service</h2><label className="mt-4 block text-ui-11">Esplora-compatible API<input className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><p className="mt-3 text-ui-10 text-[color:var(--color-muted)]">Public Esplora operators can associate your wallet address with your IP address. When Tor preference is enabled, NCC routes these requests through Tor.</p><div className="mt-4 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => setPrefsOpen(false)}>Cancel</button><button disabled={busy} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 text-white" onClick={() => void saveSettings()}>Save</button></div></div></div> : null}
    </section>
  )
}
