import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, RefreshCw, Send } from 'lucide-react'
import { DEFAULT_MONERO_DAEMON_URL, type MoneroWalletRecord } from '@shared/wallet'
import { MoneroWalletSession, type MoneroSendPreview, type MoneroSnapshot } from '@shared/monero-wallet'

function asError(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function MoneroWalletPanel({ onOpenIdentitySettings }: { onOpenIdentitySettings: () => void }) {
  const session = useRef<MoneroWalletSession | null>(null)
  if (!session.current) session.current = new MoneroWalletSession()
  const [snapshot, setSnapshot] = useState<MoneroSnapshot | null>(null)
  const [record, setRecord] = useState<MoneroWalletRecord | null>(null)
  const [draftSeed, setDraftSeed] = useState('')
  const [restoreSeed, setRestoreSeed] = useState('')
  const [restoreHeight, setRestoreHeight] = useState('0')
  const [challengeIndex, setChallengeIndex] = useState(0)
  const [challengeAnswer, setChallengeAnswer] = useState('')
  const [syncChoice, setSyncChoice] = useState<'local' | 'encrypted-relay'>('local')
  const [daemonUrl, setDaemonUrl] = useState(() => localStorage.getItem('ncc.wallet.monero-daemon') || DEFAULT_MONERO_DAEMON_URL)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [identityReady, setIdentityReady] = useState<boolean | null>(null)
  const [scanning, setScanning] = useState(false)
  const [message, setMessage] = useState('')
  const [sendAddress, setSendAddress] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [preview, setPreview] = useState<MoneroSendPreview | null>(null)

  useEffect(() => {
    let alive = true
    void window.ncc.walletStatus().then(async (status) => {
      if (!alive) return
      setIdentityReady(status.identityReady)
      if (!status.identityReady) { setMessage('Monero uses your unlocked local Nostr identity; there is no separate wallet password.'); return null }
      return window.ncc.walletLoadMoneroRecord()
    }).then(async (found) => {
      if (!alive || !found) return
      setRecord(found); setSyncChoice(found.syncChoice)
      await openAndSync(found)
    }).catch((error: unknown) => { if (alive) setMessage(asError(error)) })
    return () => { alive = false; void session.current?.close() }
  }, [])

  useEffect(() => {
    if (!snapshot?.address) { setQr(''); return }
    void QRCode.toDataURL(`monero:${snapshot.address}`, { width: 220, margin: 1 }).then(setQr).catch((error: unknown) => setMessage(asError(error)))
  }, [snapshot?.address])

  async function openAndSync(saved: MoneroWalletRecord) {
    if (busy) return
    setBusy(true); setScanning(true); setMessage('Opening wallet and scanning from its restore height. This can take a while.')
    const timer = window.setInterval(() => setMessage(`Scanning block ${session.current?.progress.height.toLocaleString() ?? '…'} of ${session.current?.progress.endHeight.toLocaleString() ?? '…'} (${Math.floor(session.current?.progress.percent ?? 0)}%).`), 1000)
    try {
      await session.current!.open({ seed: saved.seed, daemonUrl, restoreHeight: saved.restoreHeight })
      const next = await session.current!.sync()
      setSnapshot(next); setMessage('Monero wallet is synced.'); localStorage.setItem('ncc.wallet.monero-daemon', daemonUrl)
    } catch (error) { setMessage(asError(error)) }
    finally { clearInterval(timer); setBusy(false); setScanning(false) }
  }

  async function createDraft() {
    setBusy(true); setMessage('Creating a wallet on this device…')
    try {
      const generated = await session.current!.create(daemonUrl)
      setDraftSeed(generated.seed); setRestoreHeight(String(generated.restoreHeight)); setRestoreSeed('')
      chooseChallenge(generated.seed)
    } catch (error) { setMessage(asError(error)) }
    finally { setBusy(false) }
  }

  function chooseChallenge(seed: string) {
    const words = seed.trim().split(/\s+/)
    setChallengeIndex(Math.floor(Math.random() * words.length))
    setChallengeAnswer('')
  }

  function beginRestore() {
    const words = restoreSeed.trim().split(/\s+/)
    if (words.length !== 25) { setMessage('A Monero legacy seed has 25 words. Enter all 25 words to continue.'); return }
    setDraftSeed(restoreSeed.trim()); setRestoreSeed(''); chooseChallenge(restoreSeed)
  }

  async function confirmBackup() {
    const words = draftSeed.trim().split(/\s+/)
    if (challengeAnswer.trim().toLowerCase() !== words[challengeIndex]?.toLowerCase()) { setMessage(`Word ${challengeIndex + 1} does not match. Check your backup and try again.`); return }
    setBusy(true)
    try {
      const address = await session.current!.deriveAddress(draftSeed)
      const saved: MoneroWalletRecord = { version: 1, seed: draftSeed, address, restoreHeight: Number(restoreHeight), backupConfirmed: true, syncChoice }
      await window.ncc.walletSaveMoneroRecord(saved)
      setRecord(saved); setDraftSeed(''); setMessage('Backup check passed. Scanning the Monero chain…'); setScanning(true)
      localStorage.setItem('ncc.wallet.monero-daemon', daemonUrl)
      await session.current!.open({ seed: saved.seed, daemonUrl, restoreHeight: saved.restoreHeight })
      const next = await session.current!.sync(); setSnapshot(next); setMessage('Monero wallet is synced.')
    } catch (error) { setMessage(asError(error)) }
    finally { setBusy(false); setScanning(false) }
  }

  async function refresh() {
    if (!record) return
    setBusy(true); setScanning(true)
    const timer = window.setInterval(() => setMessage(`Scanning block ${session.current?.progress.height.toLocaleString() ?? '…'} (${Math.floor(session.current?.progress.percent ?? 0)}%).`), 1000)
    try { setSnapshot(await session.current!.sync()); setMessage('Monero wallet is synced.') }
    catch (error) { setMessage(asError(error)) }
    finally { clearInterval(timer); setBusy(false); setScanning(false) }
  }

  async function reviewSend() {
    setBusy(true)
    try { setPreview(await session.current!.prepareSend(sendAddress, sendAmount)); setMessage('Review the actual wallet fee and destination before sending.') }
    catch (error) { setMessage(asError(error)) }
    finally { setBusy(false) }
  }

  async function confirmSend() {
    if (!preview || !window.confirm('Send this Monero transaction now? This cannot be reversed.')) return
    setBusy(true)
    try {
      const ids = await session.current!.confirmSend(preview.id)
      setPreview(null); setSendAddress(''); setSendAmount(''); setMessage(`Broadcast ${ids.length} Monero transaction${ids.length === 1 ? '' : 's'}.`)
      setSnapshot(await session.current!.snapshot())
    } catch (error) { setMessage(asError(error)) }
    finally { setBusy(false) }
  }

  const words = draftSeed.trim().split(/\s+/).filter(Boolean)
  return <div className="space-y-4">
    <article className="rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-ui-15 font-semibold">Monero</h2><p className="mt-1 text-ui-11 text-[color:var(--color-muted)]">Wallet keys stay on this device. A remote daemon supplies block data; it never receives your view key, but it can see your IP and scan requests.</p></div>{record ? <button aria-label="Refresh Monero wallet" disabled={busy} className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button> : null}</div>
      {record ? <>
        <div className="mt-5 flex items-start justify-between gap-3"><div><p className="text-ui-11 text-[color:var(--color-muted)]">Total balance</p><p className="font-mono text-ui-24">{snapshot?.balance ?? '—'} <span className="text-ui-13">XMR</span></p><p className="text-ui-10 text-[color:var(--color-muted)]">Unlocked: {snapshot?.unlocked ?? '—'} XMR {scanning ? `· scanning block ${session.current?.progress.height.toLocaleString() ?? ''}` : ''}</p></div><button disabled={!snapshot || busy} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-40" onClick={() => setPreview({ id: '', address: '', amount: '', fee: '', transactions: 0 })}><Send className="mr-1 inline h-4 w-4" />Send</button></div>
        <div className="mt-4 grid gap-4 border-t border-[color:var(--color-line)] pt-4 sm:grid-cols-[1fr_auto]"><div><p className="text-ui-11 font-semibold">Receive Monero</p><p className="mt-2 break-all font-mono text-ui-10 text-[color:var(--color-muted)]">{snapshot?.address ?? record.address}</p><button className="mt-3 rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-ui-10" onClick={() => void navigator.clipboard.writeText(snapshot?.address ?? record.address)}><Copy className="mr-1 inline h-3 w-3" />Copy address</button></div>{qr ? <img src={qr} alt="QR code for Monero receive address" className="h-36 w-36 rounded-lg bg-white p-2" /> : null}</div>
      </> : draftSeed ? <>
        <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-ui-11">Write down these 25 words in order and store them somewhere safe. Anyone with the seed can spend your Monero. This is the only way to recover this wallet.</p>
        <ol className="mt-3 grid list-none grid-cols-2 gap-2 pl-0 sm:grid-cols-3">{words.map((word, index) => <li key={`${index}-${word}`} className="rounded-lg bg-[color:var(--color-hover)] px-2 py-1.5 font-mono text-ui-10"><span className="mr-2 text-[color:var(--color-muted)]">{index + 1}</span>{word}</li>)}</ol>
        <label className="mt-4 block text-ui-11">Enter word {challengeIndex + 1} to confirm your backup<input autoComplete="off" className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono" value={challengeAnswer} onChange={(event) => setChallengeAnswer(event.target.value)} /></label>
        <label className="mt-3 block text-ui-11">Wallet sync mode<select className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3" value={syncChoice} onChange={(event) => setSyncChoice(event.target.value as 'local' | 'encrypted-relay')}><option value="local">This device only</option><option value="encrypted-relay">Encrypted Nostr relay sync</option></select></label>
        <div className="mt-4 flex justify-end gap-2"><button className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={() => { setDraftSeed(''); setMessage('') }}>Cancel</button><button disabled={busy || !challengeAnswer} className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void confirmBackup()}>I backed up my seed</button></div>
      </> : <>
        <p className="mt-4 text-ui-11">Your unlocked local Nostr identity opens this wallet; there is no separate wallet password. Create a wallet or restore one with its 25-word recovery seed.</p>
        {identityReady === false ? <button className="mt-3 rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={onOpenIdentitySettings}>Set up or unlock identity</button> : null}
        <label className="mt-3 block text-ui-11">Monero daemon URL<input className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10" value={daemonUrl} onChange={(event) => setDaemonUrl(event.target.value)} /></label>
        <button disabled={busy || !daemonUrl || !identityReady} className="mt-3 rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50" onClick={() => void createDraft()}>Create wallet</button>
        <details className="mt-4"><summary className="cursor-pointer text-ui-11">Restore a wallet</summary><textarea className="mt-3 min-h-24 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10" placeholder="Enter the 25-word Monero recovery seed" value={restoreSeed} onChange={(event) => setRestoreSeed(event.target.value)} /><label className="mt-2 block text-ui-11">Restore from block height<input type="number" min="0" className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3" value={restoreHeight} onChange={(event) => setRestoreHeight(event.target.value)} /></label><button disabled={busy || !identityReady} className="mt-3 rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11" onClick={beginRestore}>Continue to backup check</button></details>
      </>}
    </article>
    {record && <article className="rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5"><h3 className="text-ui-13 font-semibold">Recent Monero transactions</h3>{snapshot?.transactions.length ? <ul className="mt-2 divide-y divide-[color:var(--color-line)]">{snapshot.transactions.map((tx) => <li key={tx.id} className="flex items-center justify-between gap-3 py-3"><div><p className="font-mono text-ui-10">{tx.id.slice(0, 12)}…{tx.id.slice(-8)}</p><p className="text-ui-10 text-[color:var(--color-muted)]">{tx.direction} · {tx.status} · {tx.confirmations} confirmations</p></div><span className="font-mono text-ui-11">{tx.direction === 'incoming' ? '+' : '−'}{tx.amount} XMR</span></li>)}</ul> : <p className="py-5 text-center text-ui-11 text-[color:var(--color-muted)]">{scanning ? 'Scanning…' : 'No Monero transactions found.'}</p>}</article>}
    {message ? <p role="status" className="rounded-lg border border-[color:var(--color-line)] p-3 text-ui-11">{message}</p> : null}
    {record && <label className="block text-ui-10 text-[color:var(--color-muted)]">Daemon<input className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-2 font-mono" value={daemonUrl} onChange={(event) => setDaemonUrl(event.target.value)} /></label>}
    {preview && !preview.id ? <div className="rounded-xl border border-[color:var(--color-line)] p-4"><h3 className="text-ui-13 font-semibold">Send Monero</h3><input className="mt-3 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10" placeholder="Monero address" value={sendAddress} onChange={(event) => setSendAddress(event.target.value)} /><input inputMode="decimal" className="mt-2 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono" placeholder="Amount in XMR" value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} /><div className="mt-3 flex justify-end gap-2"><button className="rounded-lg border px-3 py-2 text-ui-10" onClick={() => setPreview(null)}>Cancel</button><button disabled={busy || !sendAddress || !sendAmount} className="rounded-lg bg-[color:var(--color-accent)] px-3 py-2 text-ui-10 text-white disabled:opacity-50" onClick={() => void reviewSend()}>Review fee</button></div></div> : null}
    {preview?.id ? <div role="dialog" aria-modal="true" className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4"><h3 className="text-ui-13 font-semibold">Confirm Monero send</h3><p className="mt-3 break-all font-mono text-ui-10">To: {preview.address}</p><p className="mt-2 text-ui-11">Amount: {preview.amount} XMR</p><p className="text-ui-11">Network fee: {preview.fee} XMR</p><p className="text-ui-10 text-[color:var(--color-muted)]">{preview.transactions} transaction(s). Monero transfers cannot be reversed.</p><div className="mt-3 flex justify-end gap-2"><button className="rounded-lg border px-3 py-2 text-ui-10" onClick={() => { setPreview(null); setMessage('') }}>Cancel</button><button disabled={busy} className="rounded-lg bg-[color:var(--color-danger)] px-3 py-2 text-ui-10 text-white disabled:opacity-50" onClick={() => void confirmSend()}>Confirm and send</button></div></div> : null}
  </div>
}
