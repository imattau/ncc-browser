import { useMemo, useState } from 'react'
import { ArrowUpFromLine, Copy } from 'lucide-react'
import { BitcoinSendDialog } from './BitcoinSendDialog'
import { BitcoinSettingsDialog } from './BitcoinSettingsDialog'
import { shortId, type WalletContext } from './types'
import { useBitcoinSend } from './useBitcoinSend'
import { useQrCode } from './useQrCode'
import { LightningScannerDialog } from './LightningScannerDialog'
import { useLightningScanner } from './useLightningScanner'

/** Bitcoin balance, receive address, transactions and its two dialogs. */
export function BitcoinView({ wallet }: { wallet: WalletContext }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const snapshot = wallet.snapshot
  const receiveAddress = useMemo(
    () => snapshot?.receive.find((item) => item.currency === 'BTC')?.address ?? '',
    [snapshot]
  )
  const qr = useQrCode(receiveAddress, 'bitcoin', wallet.setMessage)
  const send = useBitcoinSend(wallet)
  const scanner = useLightningScanner(scannerOpen, (value) => {
    const payload = value.trim().replace(/^bitcoin:/i, '')
    const [scannedAddress, query = ''] = payload.split('?')
    if (!scannedAddress) { wallet.setMessage('The QR code does not contain a Bitcoin address.'); setScannerOpen(false); return }
    send.setAddress(scannedAddress)
    const amount = new URLSearchParams(query).get('amount')
    if (amount) send.setAmount(amount)
    wallet.setMessage('Bitcoin payment QR scanned.')
    setScannerOpen(false)
  })
  const transactions = (snapshot?.transactions ?? []).filter((tx) => tx.currency === 'BTC')

  return (
    <>
      <section className="wallet-simple-view">
        <div className="wallet-simple-balance">
          <p>
            {snapshot?.balances.find((item) => item.currency === 'BTC')?.available ?? '—'} BTC
          </p>
          <span>
            Available
            {snapshot
              ? ` · ${snapshot.balances.find((item) => item.currency === 'BTC')?.pending ?? '0'} BTC pending`
              : ''}
          </span>
        </div>
        <button
          disabled={!snapshot?.status.bitcoinAvailable || wallet.busy}
          className="wallet-primary-send"
          onClick={send.start}
        >
          <ArrowUpFromLine className="h-4 w-4" />
          Send
        </button>
        {snapshot?.status.bitcoinAddress ? (
          <div className="wallet-receive-simple">
            <h3 className="text-ui-12 font-semibold">Receive Bitcoin</h3>
            {qr ? (
              <img src={qr} alt="QR code for Bitcoin receive address" className="wallet-receive-qr" />
            ) : null}
            <button
              className="wallet-address-pill"
              onClick={() => void wallet.copy(snapshot.status.bitcoinAddress!)}
            >
              <span>{shortId(snapshot.status.bitcoinAddress)}</span>
              <Copy className="h-4 w-4 shrink-0" />
            </button>
          </div>
        ) : (
          <div className="mt-6 text-center text-ui-11 text-[color:var(--color-muted)]">
            <p>
              {snapshot?.status.identityReady === false
                ? 'Unlock your identity to access this wallet.'
                : snapshot?.status.error ?? 'Loading wallet…'}
            </p>
            {snapshot?.status.identityReady === false ? (
              <button
                className="mt-3 rounded-lg border border-[color:var(--color-line)] px-3 py-2"
                onClick={wallet.onOpenIdentitySettings}
              >
                Set up or unlock identity
              </button>
            ) : null}
          </div>
        )}
      </section>

      <details className="wallet-transactions-simple">
        <summary>
          Transactions <span>⌄</span>
        </summary>
        {transactions.length ? (
          <ul className="mt-3 divide-y divide-[color:var(--color-line)]">
            {transactions.map((tx) => (
              <li key={tx.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-mono text-ui-11">{shortId(tx.id)}</p>
                  <p className="text-ui-10 text-[color:var(--color-muted)]">
                    {tx.direction} · {tx.status} · {tx.confirmations} confirmations
                  </p>
                </div>
                <span className="font-mono text-ui-11">
                  {tx.direction === 'incoming' ? '+' : '−'}
                  {tx.amount} BTC
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-5 text-center text-ui-11 text-[color:var(--color-muted)]">
            {wallet.busy ? 'Loading…' : 'No transactions yet.'}
          </p>
        )}
      </details>

      {wallet.settings ? (
        <details className="text-center text-ui-10 text-[color:var(--color-muted)]">
          <summary className="cursor-pointer">Network and privacy</summary>
          <p className="mt-2">
            Bitcoin data service: {wallet.settings.esploraUrl}. {wallet.settings.privacyNotice}
          </p>
          <button className="mt-2 underline" onClick={() => setSettingsOpen(true)}>
            Change service
          </button>
        </details>
      ) : null}

      <BitcoinSendDialog
        open={send.open}
        preview={send.preview}
        address={send.address}
        amount={send.amount}
        busy={wallet.busy}
        onAddress={send.setAddress}
        onAmount={send.setAmount}
        onScan={() => setScannerOpen(true)}
        onPrepare={() => void send.prepare()}
        onConfirm={() => void send.confirm()}
        onClose={send.close}
      />

      <LightningScannerDialog open={scannerOpen} videoRef={scanner.videoRef} error={scanner.scannerError} currency="Bitcoin" instruction="Hold a Bitcoin address QR code in front of your camera." onClose={() => setScannerOpen(false)} />

      <BitcoinSettingsDialog
        open={settingsOpen}
        settings={wallet.settings}
        busy={wallet.busy}
        onSave={wallet.saveSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  )
}
