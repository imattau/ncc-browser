import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { ArrowUpFromLine, Camera, Copy, RefreshCw, ScanLine, X, Zap } from 'lucide-react'
import type { BitcoinSendPreview, NwcSnapshot, WalletSnapshot } from '@shared/wallet'
import { MoneroWalletPanel } from './MoneroWalletPanel'
import { messageOf } from '../lib/format'

type Props = { onClose: () => void; onOpenIdentitySettings: () => void }
type Settings = { esploraUrl: string; privacyNotice: string }

function shortId(id: string): string { return `${id.slice(0, 12)}…${id.slice(-8)}` }

export function WalletPanel({ onClose, onOpenIdentitySettings }: Props) {
  const [currency, setCurrency] = useState<'BTC' | 'XMR' | 'LN'>('BTC')
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
  const [nwc, setNwc] = useState<NwcSnapshot | null>(null)
  const [nwcUri, setNwcUri] = useState('')
  const [lightningInvoice, setLightningInvoice] = useState('')
  const [lightningAmount, setLightningAmount] = useState('')
  const [receiveInvoice, setReceiveInvoice] = useState('')
  const [lightningQr, setLightningQr] = useState('')
  const [lightningSendOpen, setLightningSendOpen] = useState(false)
  const [lightningReceiveOpen, setLightningReceiveOpen] = useState(false)
  const [lightningPayReview, setLightningPayReview] = useState(false)
  const [lightningScannerOpen, setLightningScannerOpen] = useState(false)
  const [scannerError, setScannerError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)

  const receiveAddress = useMemo(() => snapshot?.receive.find((item) => item.currency === (currency === 'XMR' ? 'XMR' : 'BTC'))?.address ?? '', [snapshot, currency])

  async function refresh() {
    setBusy(true)
    setMessage('')
    try {
      const [next, prefs] = await Promise.all([window.ncc.walletSnapshot(), window.ncc.walletSettings()])
      setSnapshot(next)
      setSettings(prefs)
      setEndpoint(prefs.esploraUrl)
      const nwcStatus = await window.ncc.nwcStatus()
      setNwc(nwcStatus.connected ? await window.ncc.nwcRefresh() : nwcStatus)
    } catch (error) { setMessage(messageOf(error)) }
    finally { setBusy(false) }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!receiveAddress) { setQr(''); return }
    void QRCode.toDataURL(`bitcoin:${receiveAddress}`, { width: 300, margin: 1, color: { dark: '#101418', light: '#ffffff' } })
      .then(setQr).catch((error: unknown) => setMessage(messageOf(error)))
  }, [receiveAddress])
  useEffect(() => {
    if (!receiveInvoice) { setLightningQr(''); return }
    void QRCode.toDataURL(`lightning:${receiveInvoice}`, { width: 300, margin: 1, color: { dark: '#101418', light: '#ffffff' } })
      .then(setLightningQr).catch((error: unknown) => setMessage(messageOf(error)))
  }, [receiveInvoice])

  useEffect(() => {
    if (!lightningScannerOpen) return
    let active = true
    let stream: MediaStream | null = null
    let animationFrame = 0
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    setScannerError('')
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this app.')
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (!active) { stream.getTracks().forEach((track) => track.stop()); return }
        const video = videoRef.current
        if (!video) throw new Error('Camera preview could not be opened.')
        video.srcObject = stream
        await video.play()
        const scan = () => {
          if (!active || !video.videoWidth || !video.videoHeight || !context) { animationFrame = requestAnimationFrame(scan); return }
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
          const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
          if (result?.data) {
            const invoice = result.data.trim().replace(/^lightning:/i, '')
            if (/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) {
              setLightningInvoice(invoice)
              setLightningPayReview(false)
              setLightningScannerOpen(false)
              setMessage('Lightning invoice scanned.')
              return
            }
            setScannerError('That QR code does not contain a Lightning invoice.')
          }
          animationFrame = requestAnimationFrame(scan)
        }
        animationFrame = requestAnimationFrame(scan)
      } catch (error) {
        setScannerError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      active = false
      cancelAnimationFrame(animationFrame)
      stream?.getTracks().forEach((track) => track.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [lightningScannerOpen])

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage('Copied to clipboard.') }
    catch { setMessage('Could not copy to clipboard.') }
  }

  async function prepare() {
    setBusy(true); setMessage('')
    try { setPreview(await window.ncc.walletPrepareBitcoinSend(sendAddress, sendAmount)) }
    catch (error) { setMessage(messageOf(error)) }
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
    } catch (error) { setMessage(messageOf(error)) }
    finally { setBusy(false) }
  }

  async function saveSettings() {
    setBusy(true)
    try { setSettings(await window.ncc.walletSetSettings({ esploraUrl: endpoint })); setPrefsOpen(false); await refresh() }
    catch (error) { setMessage(messageOf(error)) }
    finally { setBusy(false) }
  }

  async function connectNwc() {
    setBusy(true); setMessage('')
    try { setNwc(await window.ncc.nwcConnect(nwcUri)); setNwcUri(''); setMessage('Lightning wallet connected.') }
    catch (error) { setMessage(messageOf(error)) }
    finally { setBusy(false) }
  }

  async function payLightningInvoice() {
    if (!lightningInvoice.trim()) return
    setBusy(true); setMessage('')
    try { await window.ncc.nwcPay(lightningInvoice.trim()); setLightningInvoice(''); setLightningPayReview(false); setLightningSendOpen(false); setMessage('Lightning payment sent.') }
    catch (error) { setMessage(messageOf(error)) }
    finally { setBusy(false) }
  }

  async function createLightningInvoice() {
    const sats = Number(lightningAmount)
    if (!Number.isSafeInteger(sats) || sats <= 0 || sats > Number.MAX_SAFE_INTEGER / 1000) { setMessage('Enter a valid amount in sats.'); return }
    setBusy(true); setMessage('')
    try { const result = await window.ncc.nwcMakeInvoice({ amount: sats * 1000 }); setReceiveInvoice(result.invoice); setLightningReceiveOpen(false); setMessage('Lightning invoice created.') }
    catch (error) { setMessage(messageOf(error)) }
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
          {(['BTC', 'XMR', 'LN'] as const).map((item) => <button key={item} type="button" aria-label={item === 'BTC' ? 'Bitcoin' : item === 'XMR' ? 'Monero' : 'Lightning'} title={item === 'BTC' ? 'Bitcoin' : item === 'XMR' ? 'Monero' : 'Lightning'} aria-pressed={currency === item} className={`grid h-10 w-10 place-items-center rounded-full text-ui-18 ${currency === item ? 'bg-[color:var(--color-hover)] text-[color:var(--color-text-strong)]' : 'text-[color:var(--color-muted)]'}`} onClick={() => setCurrency(item)}>{item === 'BTC' ? <span aria-hidden="true">₿</span> : item === 'XMR' ? <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full border-2 border-[#f26822] text-ui-12 font-bold text-[#f26822]">M</span> : <Zap aria-hidden="true" className="h-5 w-5" />}</button>)}
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
        </> : currency === 'XMR' ? <MoneroWalletPanel onOpenIdentitySettings={onOpenIdentitySettings} /> : <>
          {nwc?.connected ? <section className="wallet-simple-view">
            <div className="wallet-simple-balance"><p>{nwc.balanceMsat === null ? '—' : (nwc.balanceMsat / 1000).toLocaleString()} sats</p><span>{nwc.alias || 'Lightning wallet'}{nwc.network ? ` · ${nwc.network}` : ''}</span></div>
            <div className="flex flex-wrap justify-center gap-2"><button className="wallet-primary-send" onClick={() => { setLightningSendOpen(true); setLightningPayReview(false) }}><ArrowUpFromLine className="h-4 w-4" />Send</button><button className="wallet-primary-send" onClick={() => setLightningReceiveOpen(true)}>Receive</button></div>
            {lightningQr ? <div className="wallet-receive-simple"><img src={lightningQr} alt="QR code for Lightning invoice" className="wallet-receive-qr" /><button className="wallet-address-pill" onClick={() => void copy(receiveInvoice)}><span>{shortId(receiveInvoice)}</span><Copy className="h-4 w-4 shrink-0" /></button></div> : null}
          </section> : null}
          <details className="wallet-settings"><summary>{nwc?.connected ? 'Lightning wallet settings' : 'Connect a Lightning wallet'}</summary>
            {nwc?.connected ? <div className="mt-3"><p className="text-ui-10 text-[color:var(--color-muted)]">{nwc.alias || 'Nostr Wallet Connect'}{nwc.network ? ` · ${nwc.network}` : ''}</p><button className="mt-2 text-ui-10 text-[color:var(--color-muted)] underline" onClick={() => void window.ncc.nwcDisconnect().then(setNwc)}>Disconnect wallet</button></div> : <div className="mt-3"><p className="text-ui-10 text-[color:var(--color-muted)]">Connect with a Nostr Wallet Connect URI.</p><label className="mt-3 block text-ui-10">NWC connection URI<input aria-label="NWC connection URI" placeholder="nostr+walletconnect://…" className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-2 font-mono text-ui-10" value={nwcUri} onChange={(event) => setNwcUri(event.target.value)} /></label><button disabled={busy || !nwcUri.trim()} className="mt-3 rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-10 text-white disabled:opacity-50" onClick={() => void connectNwc()}>Connect</button></div>}
          </details>
        </>}
        {message ? <p role="status" className="rounded-lg border border-[color:var(--color-line)] p-3 text-ui-11">{message}</p> : null}
        {currency === 'BTC' && settings ? <details className="text-center text-ui-10 text-[color:var(--color-muted)]"><summary className="cursor-pointer">Network and privacy</summary><p className="mt-2">Bitcoin data service: {settings.esploraUrl}. {settings.privacyNotice}</p><button className="mt-2 underline" onClick={() => setPrefsOpen(true)}>Change service</button></details> : null}
      </div>

      {sendOpen ? <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"><div role="dialog" aria-modal="true" aria-labelledby="btc-send-title" className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"><h2 id="btc-send-title" className="text-ui-16 font-semibold">Send Bitcoin</h2>{preview ? <><p className="mt-4 break-all font-mono text-ui-11">To: {preview.address}</p><p className="mt-3 text-ui-12">Amount: {preview.amountSats.toLocaleString()} sats</p><p className="mt-1 text-ui-12">Network fee: {preview.feeSats.toLocaleString()} sats</p><p className="mt-1 text-ui-12 font-semibold">Total: {preview.totalSats.toLocaleString()} sats</p><p className="mt-3 text-ui-10 text-[color:var(--color-muted)]">This transaction is irreversible. Review the address and amount carefully.</p></> : <div className="mt-4 space-y-3"><label className="block text-ui-11">Destination address<input autoFocus className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-11" value={sendAddress} onChange={(event) => setSendAddress(event.target.value)} /></label><label className="block text-ui-11">Amount in BTC<input inputMode="decimal" className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-11" value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} /></label></div>}<div className="mt-5 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => { setSendOpen(false); setPreview(null) }}>Cancel</button>{preview ? <button disabled={busy} className="rounded-lg bg-[color:var(--color-danger)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void confirm()}>Confirm and send</button> : <button disabled={busy || !sendAddress || !sendAmount} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void prepare()}>Review fee</button>}</div></div></div> : null}

      {lightningSendOpen ? <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"><div role="dialog" aria-modal="true" aria-labelledby="lightning-send-title" className="wallet-dialog w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">Lightning</p><h2 id="lightning-send-title" className="mt-1 text-ui-16 font-semibold">{lightningPayReview ? 'Review payment' : 'Send payment'}</h2></div><button className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]" aria-label="Close send dialog" onClick={() => { setLightningSendOpen(false); setLightningPayReview(false) }}><X className="h-4 w-4" /></button></div>{lightningPayReview ? <div className="mt-4"><p className="text-ui-11 text-[color:var(--color-muted)]">Confirm that you want to pay this Lightning invoice. This payment cannot be reversed.</p><div className="mt-3 max-h-36 overflow-auto break-all rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10">{lightningInvoice}</div></div> : <><label className="mt-4 block text-ui-11">Lightning invoice<input autoFocus className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10" value={lightningInvoice} onChange={(event) => setLightningInvoice(event.target.value.trim().replace(/^lightning:/i, ''))} placeholder="lnbc…" /></label><button className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-ui-11 hover:bg-[color:var(--color-hover)]" onClick={() => setLightningScannerOpen(true)}><ScanLine className="h-4 w-4" />Scan QR code</button></>}<div className="mt-5 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => { setLightningSendOpen(false); setLightningPayReview(false) }}>Cancel</button>{lightningPayReview ? <button disabled={busy} className="rounded-lg bg-[color:var(--color-danger)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void payLightningInvoice()}>Pay invoice</button> : <button disabled={!/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(lightningInvoice.trim())} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => setLightningPayReview(true)}>Review payment</button>}</div></div></div> : null}

      {lightningReceiveOpen ? <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"><div role="dialog" aria-modal="true" aria-labelledby="lightning-receive-title" className="wallet-dialog w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">Lightning</p><h2 id="lightning-receive-title" className="mt-1 text-ui-16 font-semibold">Create invoice</h2></div><button className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]" aria-label="Close receive dialog" onClick={() => setLightningReceiveOpen(false)}><X className="h-4 w-4" /></button></div><p className="mt-3 text-ui-11 text-[color:var(--color-muted)]">Choose the amount to receive. A QR code will appear with the payment request.</p><label className="mt-4 block text-ui-11">Amount in sats<input autoFocus inputMode="numeric" type="number" min="1" step="1" className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-12" value={lightningAmount} onChange={(event) => setLightningAmount(event.target.value)} placeholder="1000" /></label><div className="mt-5 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => setLightningReceiveOpen(false)}>Cancel</button><button disabled={busy || !Number.isSafeInteger(Number(lightningAmount)) || Number(lightningAmount) <= 0} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void createLightningInvoice()}>Create invoice</button></div></div></div> : null}

      {lightningScannerOpen ? <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4"><div role="dialog" aria-modal="true" aria-labelledby="lightning-scanner-title" className="wallet-dialog w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">Lightning</p><h2 id="lightning-scanner-title" className="mt-1 text-ui-16 font-semibold">Scan invoice QR</h2></div><button className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]" aria-label="Close QR scanner" onClick={() => setLightningScannerOpen(false)}><X className="h-4 w-4" /></button></div><div className="mt-4 overflow-hidden rounded-xl bg-black"><video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline /></div><p className="mt-3 text-ui-11 text-[color:var(--color-muted)]"><Camera className="mr-1 inline h-4 w-4" />Hold a Lightning invoice QR code in front of your camera.</p>{scannerError ? <p role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-ui-11">{scannerError}</p> : null}<div className="mt-4 flex justify-end"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => setLightningScannerOpen(false)}>Close scanner</button></div></div></div> : null}

      {prefsOpen ? <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"><div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5"><h2 className="text-ui-15 font-semibold">Bitcoin data service</h2><label className="mt-4 block text-ui-11">Esplora-compatible API<input className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><p className="mt-3 text-ui-10 text-[color:var(--color-muted)]">Public Esplora operators can associate your wallet address with your IP address. When Tor preference is enabled, NCC routes these requests through Tor.</p><div className="mt-4 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => setPrefsOpen(false)}>Cancel</button><button disabled={busy} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 text-white" onClick={() => void saveSettings()}>Save</button></div></div></div> : null}
    </section>
  )
}
