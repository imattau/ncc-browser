import { useEffect, useState } from 'react'
import { Check, KeyRound, ShieldAlert, Smartphone, X } from 'lucide-react'
import type { SignerRequest } from '@shared/types'
import { cn } from '../lib/cn'

interface SignerPromptProps {
  request: SignerRequest
  onRespond: (allow: boolean, remember: boolean) => void
}

const MODE_LABEL: Record<SignerRequest['mode'], string> = {
  local: 'Local key',
  nip46: 'Remote signer',
  none: 'No identity'
}

export function SignerPrompt({ request, onRespond }: SignerPromptProps) {
  const [remember, setRemember] = useState(false)

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

  return (
    <div
      data-signer-prompt
      role="dialog"
      aria-modal="true"
      aria-label="Signer request"
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/72 px-4 py-[9vh] backdrop-blur-sm"
    >
      <div className="ncc-fade-in w-full max-w-[560px] rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_40px_120px_rgba(0,0,0,0.65)]">
        <div className="flex items-start justify-between gap-3 border-b border-[color:var(--color-line)] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
              {remote ? <Smartphone className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-[#e7e9ef]">Signer request</h2>
              <p
                className="mt-0.5 truncate font-mono text-[11px] text-[color:var(--color-muted)]"
                title={request.service}
              >
                {request.service}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-signer-deny
            aria-label="Deny request"
            onClick={() => onRespond(false, false)}
            className="shrink-0 rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <h3 className="text-[15px] font-semibold leading-snug text-[#e7e9ef]">
            This service wants to {request.action}.
          </h3>

          {request.note ? (
            <p className="mt-2 break-all font-mono text-[11px] text-[color:var(--color-muted)]">
              {request.note}
            </p>
          ) : null}

          {request.event ? <EventPreview event={request.event} /> : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2">
            <span className="min-w-0 truncate font-mono text-[11px] text-[#c9d1e0]">
              {request.identity ? shorten(request.identity) : 'No identity configured'}
            </span>
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                remote
                  ? 'border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
              )}
            >
              {MODE_LABEL[request.mode]}
            </span>
          </div>

          <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-[color:var(--color-warn)]">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Approve only if you trust this service. On `ncc://` addresses the npub is the
              identity; a similar service name is not the same publisher.
              {remote ? ' Your remote signer will also ask you to confirm.' : ''}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-line)] px-5 py-3.5">
          <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[color:var(--color-muted)]">
            <input
              type="checkbox"
              data-signer-remember
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-3.5 w-3.5 accent-[color:var(--color-accent)]"
            />
            Always allow this service
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-signer-deny
              onClick={() => onRespond(false, false)}
              className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
            >
              Deny
            </button>
            <button
              type="button"
              data-signer-allow
              onClick={() => onRespond(true, remember)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-[#0b0c10]"
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
    <div className="mt-3 overflow-hidden rounded-xl border border-[color:var(--color-line)] bg-[#0e1016]">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--color-line)] px-3 py-2 text-[11px] text-[color:var(--color-muted)]">
        <span className="font-mono">kind {event.kind}</span>
        <span>{timestamp}</span>
      </div>

      {event.tags.length > 0 ? (
        <div className="max-h-24 overflow-y-auto border-b border-[color:var(--color-line)] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-[#8f9aac]">
          {event.tags.slice(0, 12).map((tag, index) => (
            <div key={index} className="truncate">
              <span className="text-[color:var(--color-accent)]">[{tag[0]}]</span>{' '}
              {tag.slice(1).join(' · ')}
            </div>
          ))}
          {event.tags.length > 12 ? <div>+{event.tags.length - 12} more…</div> : null}
        </div>
      ) : null}

      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-[#dfe3ea]">
        {content || '(empty content)'}
      </pre>
    </div>
  )
}

function shorten(npub: string): string {
  return npub.length > 26 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub
}
