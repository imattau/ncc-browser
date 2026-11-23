import { CreditCard, X } from 'lucide-react'
import type { PaymentCardSaveRequest } from '@shared/payment-cards'

interface PaymentCardSavePromptProps {
  request: PaymentCardSaveRequest
  busy: boolean
  error: string | null
  onRespond: (action: 'save' | 'dismiss') => void
}

/** Checkout prompt asking whether to save a card. */
export function PaymentCardSavePrompt({
  request,
  busy,
  error,
  onRespond
}: PaymentCardSavePromptProps) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Save payment card"
    >
      <div className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-[color:var(--color-accent)]" />
            <h2 className="text-ui-14 font-semibold text-[color:var(--color-text-strong)]">
              {request.mode === 'update' ? 'Update saved card?' : 'Save payment card?'}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => onRespond('dismiss')}
            className="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-3 text-ui-12 text-[color:var(--color-text)]">
          {request.network} ending in <strong>•••• {request.last4}</strong>
        </p>
        <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          This card will be encrypted with your Nostr identity and synced to your configured
          relays.
          {request.includesSecurityCode
            ? ' The security code from this checkout will be included because security-code saving is enabled.'
            : ' No security code will be saved.'}
        </p>
        {error ? <p className="mt-3 text-ui-11 text-[color:var(--color-danger)]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRespond('dismiss')}
            className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-11 text-[color:var(--color-muted)]"
          >
            Not now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRespond('save')}
            className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
          >
            {busy ? 'Saving…' : request.mode === 'update' ? 'Update card' : 'Save card'}
          </button>
        </div>
      </div>
    </div>
  )
}
