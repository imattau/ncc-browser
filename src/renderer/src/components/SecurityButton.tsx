import { Globe, Lock } from 'lucide-react'
import type { NavState } from '@shared/types'
import { cn } from '../lib/cn'

interface SecurityButtonProps {
  state: NavState
  onOpen: () => void
}

type Tone = 'ok' | 'accent' | 'warn' | 'danger' | 'muted'

/**
 * One compact lock instead of separate transport, anchor and failure chips.
 * The lock colour is the worst transport state; the small dot is the NCC-02 anchor
 * state. Clicking it opens the full site information panel.
 */
export function SecurityButton({ state, onOpen }: SecurityButtonProps) {
  if (state.mode === 'blank') return null

  const security = state.security
  const failure = state.failure
  const web = state.mode === 'web'
  const anchor = security?.anchor ?? null

  const tone: Tone = failure
    ? 'danger'
    : web
      ? 'muted'
      : !security
        ? 'muted'
        : security.transport === 'pinned-tls'
          ? 'ok'
          : security.transport === 'tls'
            ? 'accent'
            : security.transport === 'plaintext'
              ? 'warn'
              : 'muted'

  const label = failure
    ? 'failure'
    : web
      ? 'web'
      : !security
        ? 'ncc'
        : security.transport
  const anchorState = anchor?.status ?? 'none'
  const Icon = web ? Globe : Lock

  const tooltip = failure
    ? `Security problem: ${failure.code} — click for details`
    : web
      ? 'Clearnet page — click for details'
      : !security
        ? 'NCC page — resolution details'
        : `${transportLabel(security.transport)} · ${security.host}${anchor ? ` · NCC-02 ${anchor.status}` : ''} — click for details`

  return (
    <button
      type="button"
      data-security-button
      data-security-tone={tone}
      data-security-label={label}
      data-anchor-state={anchorState}
      aria-label={`Site security (${label})`}
      title={tooltip}
      onClick={onOpen}
      className={cn(
        'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/5',
        toneText(tone)
      )}
    >
      <Icon className="h-4 w-4" />
      {!web && !failure && anchor ? (
        <span
          aria-hidden
          className={cn(
            'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
            anchorDot(anchor.status)
          )}
        />
      ) : null}
    </button>
  )
}

function toneText(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'text-[color:var(--color-ok)]'
    case 'accent':
      return 'text-[color:var(--color-accent)]'
    case 'warn':
      return 'text-[color:var(--color-warn)]'
    case 'danger':
      return 'text-[color:var(--color-danger)]'
    default:
      return 'text-[color:var(--color-muted)]'
  }
}

function anchorDot(status: string): string {
  if (status === 'anchored') return 'bg-[color:var(--color-ok)]'
  if (status === 'expired' || status === 'invalid' || status === 'required-missing') {
    return 'bg-[color:var(--color-warn)]'
  }
  return 'bg-[#5d6575]'
}

function transportLabel(transport: string): string {
  if (transport === 'pinned-tls') return 'Pinned TLS'
  if (transport === 'tls') return 'TLS'
  if (transport === 'plaintext') return 'Plaintext'
  return 'Unknown transport'
}
