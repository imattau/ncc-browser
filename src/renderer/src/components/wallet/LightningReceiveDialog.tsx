import { X } from 'lucide-react'

interface LightningReceiveDialogProps {
  open: boolean
  amount: string
  busy: boolean
  onAmount: (value: string) => void
  onCreate: () => void
  onClose: () => void
}

/** Amount entry for a new Lightning invoice. */
export function LightningReceiveDialog({
  open,
  amount,
  busy,
  onAmount,
  onCreate,
  onClose
}: LightningReceiveDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightning-receive-title"
        className="wallet-dialog w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
              Lightning
            </p>
            <h2 id="lightning-receive-title" className="mt-1 text-ui-16 font-semibold">
              Create invoice
            </h2>
          </div>
          <button
            className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]"
            aria-label="Close receive dialog"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-3 text-ui-11 text-[color:var(--color-muted)]">
          Choose the amount to receive. A QR code will appear with the payment request.
        </p>
        <label className="mt-4 block text-ui-11">
          Amount in sats
          <input
            autoFocus
            inputMode="numeric"
            type="number"
            min="1"
            step="1"
            className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-12"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            placeholder="1000"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            disabled={busy || !Number.isSafeInteger(Number(amount)) || Number(amount) <= 0}
            className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 font-semibold text-white disabled:opacity-50"
            onClick={onCreate}
          >
            Create invoice
          </button>
        </div>
      </div>
    </div>
  )
}
