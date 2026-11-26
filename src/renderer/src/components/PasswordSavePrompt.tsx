import { useEffect, useRef } from 'react'
import { KeyRound, LockKeyhole, ShieldAlert } from 'lucide-react'
import type { PasswordSaveRequest } from '@shared/passwords'
import { useFocusTrap } from '../lib/useFocusTrap'

interface PasswordSavePromptProps {
  request: PasswordSaveRequest
  busy: boolean
  error: string | null
  onRespond: (action: 'save' | 'never' | 'dismiss') => void
}

/** Modal save sheet. The captured password never enters this component. */
export function PasswordSavePrompt({
  request,
  busy,
  error,
  onRespond
}: PasswordSavePromptProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(true, panelRef)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onRespond('dismiss')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onRespond])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[color:var(--color-scrim-strong)] px-4 py-[9vh] backdrop-blur-sm"
      data-password-save-prompt
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Save password"
        className="ncc-fade-in w-full max-w-[420px] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_30px_100px_rgba(0,0,0,0.65)]"
      >
        <div className="flex items-start gap-3 border-b border-[color:var(--color-line)] px-4 py-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
            <LockKeyhole className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui-13 font-semibold text-[color:var(--color-text-strong)]">
              {request.mode === 'update' ? 'Update saved password?' : 'Save this login?'}
            </h2>
            <p className="mt-0.5 text-ui-11 text-[color:var(--color-muted)]">
              Stored encrypted in your Nostr vault.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
            <p className="truncate font-mono text-ui-12 text-[color:var(--color-text)]">
              {request.origin}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-ui-11 text-[color:var(--color-muted)]">
              <KeyRound className="h-3.5 w-3.5" />
              {request.username || 'No username'}
            </p>
            {request.title ? (
              <p className="mt-0.5 truncate text-ui-105 text-[color:var(--color-faint)]">
                {request.title}
              </p>
            ) : null}
          </div>

          {!request.secure ? (
            <p className="flex items-start gap-2 rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2.5 py-2 text-ui-11 leading-relaxed text-[color:var(--color-warn)]">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This page is not protected by TLS. Save only if you trust the connection.
            </p>
          ) : null}

          {request.locked ? (
            <p className="text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
              The password manager is locked. Saving will ask you to unlock it first.
            </p>
          ) : null}

          {error ? (
            <p className="text-ui-11 leading-relaxed text-[color:var(--color-danger)]">{error}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-4 py-3">
          <button
            type="button"
            disabled={busy}
            data-password-save-action="never"
            onClick={() => onRespond('never')}
            className="mr-auto text-ui-105 text-[color:var(--color-muted)] underline-offset-2 hover:text-[color:var(--color-danger)] hover:underline disabled:opacity-40"
          >
            Never for this site
          </button>
          <button
            type="button"
            disabled={busy}
            data-password-save-action="dismiss"
            onClick={() => onRespond('dismiss')}
            className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
          >
            Not now
          </button>
          <button
            type="button"
            disabled={busy}
            data-password-save-action="save"
            onClick={() => onRespond('save')}
            className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
          >
            {busy ? 'Saving…' : error ? 'Try again' : request.mode === 'update' ? 'Update password' : 'Save login'}
          </button>
        </div>
      </div>
    </div>
  )
}
