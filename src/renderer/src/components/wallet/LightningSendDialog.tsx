import { ScanLine, X } from 'lucide-react'
import { decodeBolt11Invoice } from '@shared/bolt11'

interface LightningSendDialogProps {
  open: boolean
  review: boolean
  invoice: string
  busy: boolean
  onInvoice: (value: string) => void
  onScan: () => void
  onReview: () => void
  onPay: () => void
  onClose: () => void
}

/** Invoice paste/scan, then an explicit review before paying. */
export function LightningSendDialog({
  open,
  review,
  invoice,
  busy,
  onInvoice,
  onScan,
  onReview,
  onPay,
  onClose
}: LightningSendDialogProps) {
  if (!open) return null
  let decoded: ReturnType<typeof decodeBolt11Invoice> | null = null
  let decodeError = ''
  if (invoice.trim()) {
    try { decoded = decodeBolt11Invoice(invoice) }
    catch (error) { decodeError = error instanceof Error ? error.message : String(error) }
  }
  const amountMsat = decoded?.amountMsat ? BigInt(decoded.amountMsat) : null
  const amount = amountMsat === null
    ? 'No fixed amount'
    : amountMsat % 1000n === 0n
      ? `${(amountMsat / 1000n).toLocaleString()} sats`
      : `${amountMsat.toLocaleString()} msat`

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightning-send-title"
        className="wallet-dialog w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
              Lightning
            </p>
            <h2 id="lightning-send-title" className="mt-1 text-ui-16 font-semibold">
              {review ? 'Review payment' : 'Send payment'}
            </h2>
          </div>
          <button
            className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]"
            aria-label="Close send dialog"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {review ? (
          <div className="mt-4">
            <p className="text-ui-11 text-[color:var(--color-muted)]">Check the payment details before sending. Lightning payments cannot be reversed.</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 text-ui-11">
              <dt className="text-[color:var(--color-muted)]">Amount</dt><dd>{amount}</dd>
              <dt className="text-[color:var(--color-muted)]">Network</dt><dd>{decoded?.network}</dd>
              <dt className="text-[color:var(--color-muted)]">Expires</dt><dd>{decoded ? new Date(decoded.expiresAt * 1000).toLocaleString() : 'Unavailable'}</dd>
              <dt className="text-[color:var(--color-muted)]">Description</dt><dd className="break-words">{decoded?.description ?? (decoded?.descriptionHash ? 'Private description (hash only)' : 'None provided')}</dd>
              {decoded?.payee ? <><dt className="text-[color:var(--color-muted)]">Payee</dt><dd className="break-all font-mono">{decoded.payee}</dd></> : null}
            </dl>
            {decoded?.expired ? <p role="alert" className="mt-3 text-ui-11 text-[color:var(--color-danger)]">This invoice has expired. Ask the sender for a new invoice.</p> : null}
            <div className="mt-3 max-h-36 overflow-auto break-all rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10">
              {invoice}
            </div>
          </div>
        ) : (
          <>
            <label className="mt-4 block text-ui-11">
              Lightning invoice
              <input
                autoFocus
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10"
                value={invoice}
                onChange={(event) =>
                  onInvoice(event.target.value.trim().replace(/^lightning:/i, ''))
                }
                placeholder="lnbc…"
              />
            </label>
            <button
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-ui-11 hover:bg-[color:var(--color-hover)]"
              onClick={onScan}
            >
              <ScanLine className="h-4 w-4" />
              Scan QR code
            </button>
            {decodeError ? <p role="alert" className="mt-2 text-ui-11 text-[color:var(--color-danger)]">{decodeError}</p> : null}
          </>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11"
            onClick={onClose}
          >
            Cancel
          </button>
          {review ? (
            <button
              disabled={busy || !decoded || decoded.expired}
              className="rounded-lg bg-[color:var(--color-danger)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50"
              onClick={onPay}
            >
              Pay invoice
            </button>
          ) : (
            <button
              disabled={!decoded || decoded.expired || busy}
              className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50"
              onClick={onReview}
            >
              Review payment
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
