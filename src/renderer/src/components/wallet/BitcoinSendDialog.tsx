import type { BitcoinSendPreview } from '@shared/wallet'

interface BitcoinSendDialogProps {
  open: boolean
  preview: BitcoinSendPreview | null
  address: string
  amount: string
  busy: boolean
  onAddress: (value: string) => void
  onAmount: (value: string) => void
  onPrepare: () => void
  onConfirm: () => void
  onClose: () => void
}

/** Destination/amount entry, then a fee review before broadcasting. */
export function BitcoinSendDialog({
  open,
  preview,
  address,
  amount,
  busy,
  onAddress,
  onAmount,
  onPrepare,
  onConfirm,
  onClose
}: BitcoinSendDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="btc-send-title"
        className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"
      >
        <h2 id="btc-send-title" className="text-ui-16 font-semibold">
          Send Bitcoin
        </h2>
        {preview ? (
          <>
            <p className="mt-4 break-all font-mono text-ui-11">To: {preview.address}</p>
            <p className="mt-3 text-ui-12">Amount: {preview.amountSats.toLocaleString()} sats</p>
            <p className="mt-1 text-ui-12">Network fee: {preview.feeSats.toLocaleString()} sats</p>
            <p className="mt-1 text-ui-12 font-semibold">
              Total: {preview.totalSats.toLocaleString()} sats
            </p>
            <p className="mt-3 text-ui-10 text-[color:var(--color-muted)]">
              This transaction is irreversible. Review the address and amount carefully.
            </p>
          </>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-ui-11">
              Destination address
              <input
                autoFocus
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-11"
                value={address}
                onChange={(event) => onAddress(event.target.value)}
              />
            </label>
            <label className="block text-ui-11">
              Amount in BTC
              <input
                inputMode="decimal"
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-11"
                value={amount}
                onChange={(event) => onAmount(event.target.value)}
              />
            </label>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11"
            onClick={onClose}
          >
            Cancel
          </button>
          {preview ? (
            <button
              disabled={busy}
              className="rounded-lg bg-[color:var(--color-danger)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50"
              onClick={onConfirm}
            >
              Confirm and send
            </button>
          ) : (
            <button
              disabled={busy || !address || !amount}
              className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50"
              onClick={onPrepare}
            >
              Review fee
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
