import type { PaymentCardDraft } from '@shared/payment-cards'

interface PaymentCardFormProps {
  draft: PaymentCardDraft
  editId?: string
  retainedLast4?: string
  busy: boolean
  onChange: (patch: Partial<PaymentCardDraft>) => void
  onCancel: () => void
  onSave: () => void
}

const fieldClass =
  'min-w-0 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-2.5 py-2 text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60'

/** Add/edit fields for one payment card. */
export function PaymentCardForm({
  draft,
  editId,
  retainedLast4,
  busy,
  onChange,
  onCancel,
  onSave
}: PaymentCardFormProps) {
  return (
    <div className="mt-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <p className="mb-2 text-ui-11 font-semibold text-[color:var(--color-text-strong)]">
        {editId ? 'Edit card details' : 'Add payment card'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {!editId ? (
          <input
            inputMode="numeric"
            autoComplete="cc-number"
            value={draft.number}
            onChange={(event) => onChange({ number: event.target.value })}
            placeholder="Card number"
            className={fieldClass}
          />
        ) : (
          <p className="col-span-2 text-ui-105 text-[color:var(--color-muted)]">
            Card number ending in {retainedLast4} is retained.
          </p>
        )}
        <input
          autoComplete="cc-name"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Cardholder name"
          className={fieldClass}
        />
        <input
          value={draft.nickname}
          onChange={(event) => onChange({ nickname: event.target.value })}
          placeholder="Nickname (optional)"
          className={fieldClass}
        />
        <input
          inputMode="numeric"
          autoComplete="cc-exp-month"
          value={draft.expMonth}
          onChange={(event) => onChange({ expMonth: event.target.value })}
          placeholder="Month (MM)"
          className={fieldClass}
        />
        <input
          inputMode="numeric"
          autoComplete="cc-exp-year"
          value={draft.expYear}
          onChange={(event) => onChange({ expYear: event.target.value })}
          placeholder="Year (YY or YYYY)"
          className={fieldClass}
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2.5 py-1 text-ui-105 text-[color:var(--color-muted)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSave}
          className="rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1 text-ui-105 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save card'}
        </button>
      </div>
    </div>
  )
}
