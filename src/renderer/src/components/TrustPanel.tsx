import { Anchor, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react'
import type { AnchorInfo, SecurityInfo } from '@shared/types'
import { cn } from '../lib/cn'
import { Popover } from './Popover'

interface TrustPanelProps {
  security: SecurityInfo | null
  address: string
  onClose: () => void
  onOpenSettings: () => void
}

export function TrustPanel({ security, address, onClose, onOpenSettings }: TrustPanelProps) {
  const anchor = security?.anchor ?? null
  const record = anchor?.record ?? null
  const status = anchor?.status ?? 'unanchored'

  const tone =
    status === 'anchored'
      ? 'text-[color:var(--color-ok)]'
      : status === 'expired'
        ? 'text-[color:var(--color-warn)]'
        : status === 'invalid' || status === 'required-missing'
          ? 'text-[color:var(--color-danger)]'
          : 'text-[color:var(--color-muted)]'

  const Icon =
    status === 'anchored' ? ShieldCheck : status === 'invalid' ? ShieldX : ShieldQuestion

  return (
    <Popover title="Service trust" subtitle={address} testId="trust" onClose={onClose}>
      <div className="space-y-3 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium',
              status === 'anchored'
                ? 'border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/10'
                : status === 'expired'
                  ? 'border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10'
                  : status === 'invalid' || status === 'required-missing'
                    ? 'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10'
                    : 'border-[color:var(--color-line)]',
              tone
            )}
          >
            {anchor?.fallback ? <Anchor className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
            {labelFor(anchor)}
          </span>
          {anchor?.required ? (
            <span className="text-[10.5px] text-[color:var(--color-muted)]">required</span>
          ) : (
            <span className="text-[10.5px] text-[color:var(--color-muted)]">optional</span>
          )}
        </div>

        {!record ? (
          <div className="space-y-2">
            <p className="text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
              No NCC-02 service record (kind 30059) was found for this service. The NCC-05
              locator is still signed by the publisher, but there is no separate service
              identity anchor.
            </p>
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-[11px] text-[#dfe3ea] hover:bg-white/5"
            >
              Require NCC-02 anchoring in settings
            </button>
          </div>
        ) : (
          <dl className="space-y-2">
            {anchor?.fallback ? (
              <p className="rounded-lg border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-2.5 py-2 text-[11px] leading-relaxed text-[color:var(--color-accent)]">
                NCC-05 had no usable endpoint, so this page is served from the NCC-02 `u`
                endpoint instead.
              </p>
            ) : null}

            <Row label="Service id" value={record.dTag} mono />
            <Row label="Anchor event" value={shortenId(record.eventId)} mono title={record.eventId} />
            <Row
              label="Public endpoint"
              value={record.endpoint ?? record.rawEndpoint ?? 'not published'}
              mono
              title={record.rawEndpoint ?? undefined}
            />
            <Row label="Anchor key" value={record.k ?? 'not published'} mono title={record.k ?? undefined} />
            <Row label="Key relation" value={keyRelation(anchor)} />
            <Row
              label="Anchor expires"
              value={
                record.expiresAt > 0
                  ? new Date(record.expiresAt * 1000).toLocaleString()
                  : 'no exp tag'
              }
            />
            <Row
              label="Transport"
              value={`${security?.transport ?? 'unknown'} · ${security?.host ?? 'unknown host'}`}
            />
          </dl>
        )}

        <p className="border-t border-[color:var(--color-line)] pt-2 text-[10.5px] leading-relaxed text-[#5d6575]">
          The npub in the address is the trust anchor. NCC-02 adds the service intent and
          transport key; NCC-05 supplies the reachable endpoint. A conflicting transport
          key fails closed.
        </p>
      </div>
    </Popover>
  )
}

function labelFor(anchor: AnchorInfo | null): string {
  switch (anchor?.status ?? 'unanchored') {
    case 'anchored':
      return anchor?.fallback ? 'anchored · ncc-02 fallback' : 'anchored'
    case 'expired':
      return 'anchor expired'
    case 'invalid':
      return 'anchor invalid'
    case 'required-missing':
      return 'no anchor'
    default:
      return 'unanchored'
  }
}

function keyRelation(anchor: AnchorInfo | null): string {
  switch (anchor?.kMatch) {
    case 'match':
      return 'NCC-02 and NCC-05 publish the same transport key'
    case 'anchor-only':
      return 'pinned with the NCC-02 transport key'
    case 'locator-only':
      return 'pinned with the NCC-05 endpoint key; no comparable NCC-02 key'
    case 'mismatch':
      return 'conflict (should not be served)'
    default:
      return 'no transport key published'
  }
}

function shortenId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id
}

function Row({
  label,
  value,
  mono,
  title
}: {
  label: string
  value: string
  mono?: boolean
  title?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-[10.5px] uppercase tracking-wide text-[#5d6575]">{label}</dt>
      <dd
        title={title}
        className={cn(
          'min-w-0 truncate text-right text-[11px] text-[#dfe3ea]',
          mono && 'font-mono text-[10.5px]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}
