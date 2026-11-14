import { Globe, ShieldCheck, ShieldAlert, Lock } from 'lucide-react'
import type { NavState } from '@shared/types'

interface SecurityBadgeProps {
  state: NavState
}

export function SecurityBadge({ state }: SecurityBadgeProps) {
  if (state.mode === 'blank') return null

  if (state.mode === 'web') {
    return (
      <span
        title="Loaded directly from the clearnet. NCC resolution was not involved."
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2 text-[11px] font-medium text-[color:var(--color-muted)]"
      >
        <Globe className="h-3.5 w-3.5" />
        web
      </span>
    )
  }

  const security = state.security
  if (!security) {
    return (
      <span
        title="NCC-05 address. Resolution happens on Nostr relays."
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2 text-[11px] font-medium text-[color:var(--color-muted)]"
      >
        <Lock className="h-3.5 w-3.5" />
        ncc
      </span>
    )
  }

  if (security.transport === 'pinned-tls') {
    return (
      <span
        title={`TLS certificate SPKI matches the k fingerprint signed into the locator (${security.host}).`}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/10 px-2 text-[11px] font-medium text-[color:var(--color-ok)]"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        pinned
      </span>
    )
  }

  if (security.transport === 'tls') {
    return (
      <span
        title={`TLS without a published fingerprint, so normal CA validation applies (${security.host}).`}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-2 text-[11px] font-medium text-[color:var(--color-accent)]"
      >
        <Lock className="h-3.5 w-3.5" />
        tls
      </span>
    )
  }

  return (
    <span
      title={`The locator points at a plaintext http endpoint (${security.host}). The locator is signed; the content is not authenticated.`}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2 text-[11px] font-medium text-[color:var(--color-warn)]"
    >
      <ShieldAlert className="h-3.5 w-3.5" />
      plaintext
    </span>
  )
}
