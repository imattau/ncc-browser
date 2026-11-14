import {
  Anchor as AnchorIcon,
  Globe,
  Lock,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX
} from 'lucide-react'
import type { AnchorInfo, NavState } from '@shared/types'
import { cn } from '../lib/cn'

interface SecurityBadgeProps {
  state: NavState
  onOpenTrust: () => void
}

export function SecurityBadge({ state, onOpenTrust }: SecurityBadgeProps) {
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

  return (
    <>
      {security.transport === 'pinned-tls' ? (
        <span
          title={`TLS certificate SPKI matches the k fingerprint signed into the locator (${security.host}).`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/10 px-2 text-[11px] font-medium text-[color:var(--color-ok)]"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          pinned
        </span>
      ) : security.transport === 'tls' ? (
        <span
          title={`TLS without a published fingerprint, so normal CA validation applies (${security.host}).`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-2 text-[11px] font-medium text-[color:var(--color-accent)]"
        >
          <Lock className="h-3.5 w-3.5" />
          tls
        </span>
      ) : (
        <span
          title={`The locator points at a plaintext http endpoint (${security.host}). The locator is signed; the content is not authenticated.`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2 text-[11px] font-medium text-[color:var(--color-warn)]"
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          plaintext
        </span>
      )}

      <AnchorBadge anchor={security.anchor} host={security.host} onOpen={onOpenTrust} />
    </>
  )
}

function AnchorBadge({
  anchor,
  host,
  onOpen
}: {
  anchor: AnchorInfo | null
  host: string
  onOpen: () => void
}) {
  const status = anchor?.status ?? 'unanchored'
  const record = anchor?.record ?? null

  const tone =
    status === 'anchored'
      ? 'border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
      : status === 'expired'
        ? 'border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn)]'
        : status === 'invalid' || status === 'required-missing'
          ? 'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
          : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'

  const Icon =
    status === 'anchored'
      ? ShieldCheck
      : status === 'expired'
        ? ShieldAlert
        : status === 'invalid' || status === 'required-missing'
          ? ShieldX
          : ShieldQuestion

  const label =
    status === 'anchored'
      ? anchor?.fallback
        ? 'ncc-02'
        : 'anchored'
      : status === 'expired'
        ? 'anchor expired'
        : status === 'invalid'
          ? 'anchor invalid'
          : status === 'required-missing'
            ? 'no anchor'
            : 'unanchored'

  const detail = record
    ? [
        `NCC-02 service record (${record.dTag})`,
        `endpoint ${record.endpoint ?? record.rawEndpoint ?? 'none'}`,
        record.k ? `key ${record.k}` : 'no transport key',
        anchor?.kMatch ? `key match: ${anchor.kMatch}` : '',
        anchor?.fallback ? 'served from the NCC-02 u fallback' : '',
        `host ${host}`
      ]
        .filter(Boolean)
        .join(' · ')
    : 'No NCC-02 service record was found. Anchoring is optional; turn it on in settings to require one.'

  return (
    <button
      type="button"
      data-anchor-badge
      aria-label={`Service trust (${label})`}
      title={detail}
      onClick={onOpen}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors hover:brightness-110',
        tone
      )}
    >
      {anchor?.fallback ? <AnchorIcon className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  )
}
