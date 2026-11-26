import { useState } from 'react'
import { ArrowUpFromLine, Copy } from 'lucide-react'
import { LightningReceiveDialog } from './LightningReceiveDialog'
import { LightningScannerDialog } from './LightningScannerDialog'
import { LightningSendDialog } from './LightningSendDialog'
import { shortId, type WalletContext } from './types'
import { useLightningScanner } from './useLightningScanner'
import { useLightningWallet } from './useLightningWallet'
import { useQrCode } from './useQrCode'

/** NWC balance, receive invoice, connection settings and the Lightning dialogs. */
export function LightningView({ wallet }: { wallet: WalletContext }) {
  const [showUri, setShowUri] = useState(false)
  const lightning = useLightningWallet(wallet)
  const { nwc } = wallet
  const receiveQr = useQrCode(lightning.receiveInvoice, 'lightning', wallet.setMessage)
  const scanner = useLightningScanner(lightning.scannerOpen, lightning.handleScanned)

  return (
    <>
      {nwc?.connected ? (
        <section className="wallet-simple-view">
          <div className="wallet-simple-balance">
            <p>
              {nwc.balanceMsat === null ? '—' : (nwc.balanceMsat / 1000).toLocaleString()} sats
            </p>
            <span>
              {nwc.alias || 'Lightning wallet'}
              {nwc.network ? ` · ${nwc.network}` : ''}
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button className="wallet-primary-send" onClick={lightning.startSend}>
              <ArrowUpFromLine className="h-4 w-4" />
              Send
            </button>
            <button className="wallet-primary-send" onClick={lightning.startReceive}>
              Receive
            </button>
          </div>
          {receiveQr ? (
            <div className="wallet-receive-simple">
              <img src={receiveQr} alt="QR code for Lightning invoice" className="wallet-receive-qr" />
              <button
                className="wallet-address-pill"
                onClick={() => void wallet.copy(lightning.receiveInvoice)}
              >
                <span>{shortId(lightning.receiveInvoice)}</span>
                <Copy className="h-4 w-4 shrink-0" />
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <details className="wallet-settings">
        <summary>
          {nwc?.connected ? 'Lightning wallet settings' : 'Connect a Lightning wallet'}
        </summary>
        {nwc?.connected ? (
          <div className="mt-3">
            <p className="text-ui-10 text-[color:var(--color-muted)]">
              {nwc.alias || 'Nostr Wallet Connect'}
              {nwc.network ? ` · ${nwc.network}` : ''}
            </p>
            <button
              className="mt-2 text-ui-10 text-[color:var(--color-muted)] underline"
              onClick={lightning.disconnect}
            >
              Disconnect wallet
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-ui-10 text-[color:var(--color-muted)]">
              This private connection URI can authorize wallet actions. Only connect a URI from a wallet you trust.
            </p>
            <label className="mt-3 block text-ui-10">
              NWC connection URI
              <input
                aria-label="NWC connection URI"
                type={showUri ? 'text' : 'password'}
                autoComplete="off"
                placeholder="nostr+walletconnect://…"
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-2 font-mono text-ui-10"
                value={lightning.uri}
                onChange={(event) => lightning.setUri(event.target.value)}
              />
            </label>
            <button className="mt-2 text-ui-10 underline" type="button" onClick={() => setShowUri((value) => !value)}>
              {showUri ? 'Hide connection URI' : 'Reveal connection URI'}
            </button>
            <button
              disabled={wallet.busy || !lightning.uri.trim()}
              className="mt-3 rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-10 text-white disabled:opacity-50"
              onClick={() => void lightning.connect()}
            >
              Connect
            </button>
          </div>
        )}
      </details>

      <LightningSendDialog
        open={lightning.sendOpen}
        review={lightning.payReview}
        invoice={lightning.invoice}
        busy={wallet.busy}
        onInvoice={lightning.setInvoice}
        onScan={lightning.openScanner}
        onReview={() => {
          lightning.setPayReview(true)
        }}
        onPay={() => void lightning.pay()}
        onClose={lightning.closeSend}
      />

      <LightningReceiveDialog
        open={lightning.receiveOpen}
        amount={lightning.amount}
        busy={wallet.busy}
        onAmount={lightning.setAmount}
        onCreate={() => void lightning.createInvoice()}
        onClose={lightning.closeReceive}
      />

      <LightningScannerDialog
        open={lightning.scannerOpen}
        videoRef={scanner.videoRef}
        error={scanner.scannerError}
        onClose={lightning.closeScanner}
      />
    </>
  )
}
