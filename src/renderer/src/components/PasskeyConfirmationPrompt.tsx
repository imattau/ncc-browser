import { useEffect, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { PasskeyConfirmationRequest } from '@shared/passwords'
import { useFocusTrap } from '../lib/useFocusTrap'

interface PasskeyConfirmationPromptProps {
  request: PasskeyConfirmationRequest
  onRespond: (choice: number | null) => void
}

export function PasskeyConfirmationPrompt({ request, onRespond }: PasskeyConfirmationPromptProps) {
  const [selected, setSelected] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const accountNames = request.accounts.length ? request.accounts : ['Passkey']

  useFocusTrap(true, panelRef)

  useEffect(() => setSelected(0), [request.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onRespond(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onRespond])

  const isCreate = request.action === 'Create passkey'
  const actionLabel = isCreate ? 'Create passkey' : 'Use passkey'

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-[color:var(--color-scrim-strong)] px-4 py-[8vh] backdrop-blur-sm"
      data-passkey-confirmation
      onMouseDown={() => onRespond(null)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="passkey-confirmation-title"
        className="ncc-fade-in w-full max-w-[420px] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_30px_100px_rgba(0,0,0,0.65)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[color:var(--color-line)] px-4 py-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
            <KeyRound className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="passkey-confirmation-title" className="text-ui-13 font-semibold text-[color:var(--color-text-strong)]">
              {isCreate ? 'Create a passkey?' : 'Use a passkey?'}
            </h2>
            <p className="mt-0.5 text-ui-11 text-[color:var(--color-muted)]">
              Confirm this request from the website.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
            <p className="text-ui-10 font-semibold uppercase tracking-[0.1em] text-[color:var(--color-muted)]">Website</p>
            <p className="mt-1 truncate font-mono text-ui-12 text-[color:var(--color-text-strong)]">{request.site}</p>
          </div>

          {accountNames.length > 1 ? (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-ui-11 font-medium text-[color:var(--color-text-strong)]">Choose an account</legend>
              {accountNames.map((name, index) => (
                <label key={`${name}-${index}`} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-ui-11 hover:bg-[color:var(--color-hover)]">
                  <input
                    type="radio"
                    name="passkey-account"
                    checked={selected === index}
                    onChange={() => setSelected(index)}
                  />
                  <span className="truncate">{name}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
              <p className="text-ui-10 font-semibold uppercase tracking-[0.1em] text-[color:var(--color-muted)]">Account</p>
              <p className="mt-1 flex items-center gap-2 truncate text-ui-12 text-[color:var(--color-text-strong)]">
                <ShieldCheck className="h-4 w-4 shrink-0 text-[color:var(--color-ok)]" />
                {accountNames[0]}
              </p>
            </div>
          )}

          {isCreate ? (
            <p className="text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
              The private key will be saved in your encrypted password vault.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-[color:var(--color-line)] px-4 py-3">
          <button
            type="button"
            onClick={() => onRespond(null)}
            className="rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => onRespond(selected)}
            className="rounded-lg bg-[color:var(--color-accent)] px-3 py-2 text-ui-11 font-semibold text-[color:var(--color-on-accent)] hover:brightness-110"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
