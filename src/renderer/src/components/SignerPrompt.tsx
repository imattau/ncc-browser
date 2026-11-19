import { useEffect, useRef, useState } from 'react'
import { Check, KeyRound, ShieldAlert, Smartphone, X } from 'lucide-react'
import type { SignerRequest } from '@shared/types'
import { cn } from '../lib/cn'
import { useFocusTrap } from '../lib/useFocusTrap'

interface SignerPromptProps {
  request: SignerRequest
  onRespond: (allow: boolean, remember: boolean) => void
  /** Further requests queued behind this one. */
  waiting?: number
}

const MODE_LABEL: Record<SignerRequest['mode'], string> = {
  local: 'Local key',
  nip46: 'Remote signer',
  none: 'No identity'
}

export function SignerPrompt({ request, onRespond, waiting = 0 }: SignerPromptProps) {
  const [remember, setRemember] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  useFocusTrap(true, cardRef)

  useEffect(() => {
    setRemember(false)
  }, [request.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onRespond(false, false)
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        onRespond(true, remember)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onRespond, remember])

  const remote = request.mode === 'nip46'
  const agent = request.kind === 'automation'
  const paymentCardAuth = request.kind === 'payment-card-auth'
  const browserDevelopment = agent && request.service === 'browser://development'

  return (
    <div
      data-signer-prompt
      role="dialog"
      aria-modal="true"
      aria-label={paymentCardAuth ? 'Confirm card fill' : agent ? 'Agent control request' : 'Signer request'}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[color:var(--color-scrim-strong)] px-4 py-[9vh] backdrop-blur-sm"
    >
      <div
        ref={cardRef}
        className="ncc-fade-in w-full max-w-[560px] rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_40px_120px_rgba(0,0,0,0.65)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[color:var(--color-line)] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
              {remote ? <Smartphone className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <h2 className="text-ui-13 font-semibold text-[color:var(--color-text-strong)]">{paymentCardAuth ? 'Confirm card fill' : agent ? 'Agent control request' : 'Signer request'}</h2>
              {waiting > 0 ? (
                <p className="mt-0.5 text-ui-10 text-[color:var(--color-muted)]">
                  {waiting} more waiting
                </p>
              ) : null}
              <p
                className="mt-0.5 truncate font-mono text-ui-11 text-[color:var(--color-muted)]"
                title={request.service}
              >
                {browserDevelopment ? 'Browser development tools' : request.service}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-signer-deny
            aria-label="Deny request"
            onClick={() => onRespond(false, false)}
            className="shrink-0 rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <h3 className="text-ui-15 font-semibold leading-snug text-[color:var(--color-text-strong)]">
            {paymentCardAuth
              ? 'A Nostr signer is being asked to confirm this card fill.'
              : agent
              ? browserDevelopment
                ? 'An AI agent wants to inspect and operate browser settings and prompts.'
                : `An AI agent wants to ${request.action}.`
              : `This service wants to ${request.action}.`}
          </h3>

          {request.note ? (
            <p className="mt-2 break-all font-mono text-ui-11 text-[color:var(--color-muted)]">
              {request.note}
            </p>
          ) : null}

          {request.event ? <EventPreview event={request.event} /> : null}

          {agent ? null : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2">
            <span className="min-w-0 truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
              {request.identity ? shorten(request.identity) : 'No identity configured'}
            </span>
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-ui-10 font-medium',
                remote
                  ? 'border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
              )}
            >
              {MODE_LABEL[request.mode]}
            </span>
          </div>
          )}

          <p className="mt-3 flex items-start gap-2 text-ui-11 leading-relaxed text-[color:var(--color-warn)]">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {paymentCardAuth ? (
              <span>
                A one-time challenge is signed by your active Nostr identity. It is not
                published. The card will be filled only after approval.
              </span>
            ) : agent ? (
              browserDevelopment ? (
                <span>
                  This grants access to the browser&apos;s own settings and controls. Website
                  access is still approved separately.
                </span>
              ) : (
              <span>
                The agent can read this site&apos;s pages and act as you on it: click, type and
                submit forms. Allow it only for a task you started.
              </span>
              )
            ) : (
            <span>
              Approve only if you trust this service. On `ncc://` addresses the npub is the
              identity; a similar service name is not the same publisher.
              {remote ? ' Your remote signer will also ask you to confirm.' : ''}
            </span>
            )}
          </p>
          {request.ephemeral && !agent ? (
            <p className="mt-2 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
              This private/Tor tab forgets remembered permissions when it closes.
            </p>
          ) : null}
          {request.torTab && remote ? (
            <p className="mt-2 flex items-start gap-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
              <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
              Remote-signer relay traffic is not routed through Tor.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-line)] px-5 py-3.5">
          {request.rememberable && !paymentCardAuth ? <label className="flex cursor-pointer items-center gap-2 text-ui-115 text-[color:var(--color-muted)]">
            <input
              type="checkbox"
              data-signer-remember
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-3.5 w-3.5 accent-[color:var(--color-accent)]"
            />
            {request.rememberLabel ?? 'Always allow this service'}
          </label> : <span />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-signer-deny
              data-autofocus
              onClick={() => onRespond(false, false)}
              className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-12 font-medium text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
            >
              Deny
            </button>
            <button
              type="button"
              data-signer-allow
              onClick={() => onRespond(true, remember)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-12 font-semibold text-[color:var(--color-on-accent)]"
            >
              <Check className="h-3.5 w-3.5" />
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function EventPreview({ event }: { event: NonNullable<SignerRequest['event']> }) {
  const content = event.content.length > 2000 ? `${event.content.slice(0, 2000)}…` : event.content
  const timestamp = new Date(event.created_at * 1000).toLocaleString()

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)]">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--color-line)] px-3 py-2 text-ui-11 text-[color:var(--color-muted)]">
        <span className="font-mono">kind {event.kind}</span>
        <span>{timestamp}</span>
      </div>

      {event.tags.length > 0 ? (
        <div className="max-h-24 overflow-y-auto border-b border-[color:var(--color-line)] px-3 py-2 font-mono text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
          {event.tags.slice(0, 12).map((tag, index) => (
            <div key={index} className="truncate">
              <span className="text-[color:var(--color-accent)]">[{tag[0]}]</span>{' '}
              {tag.slice(1).join(' · ')}
            </div>
          ))}
          {event.tags.length > 12 ? <div>+{event.tags.length - 12} more…</div> : null}
        </div>
      ) : null}

      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-ui-11 leading-relaxed text-[color:var(--color-text)]">
        {content || '(empty content)'}
      </pre>
    </div>
  )
}

function shorten(npub: string): string {
  return npub.length > 26 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub
}
