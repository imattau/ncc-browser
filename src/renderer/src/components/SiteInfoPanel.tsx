import {
  AlertTriangle,
  Anchor as AnchorIcon,
  Globe,
  Lock,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX
} from 'lucide-react'
import { ERROR_COPY } from '@shared/types'
import type { AnchorInfo, NavState, TransportSecurity } from '@shared/types'
import { clearnetState } from '../lib/clearnet'
import { cn } from '../lib/cn'
import { Popover, type PopoverAnchor } from './Popover'

interface SiteInfoPanelProps {
  state: NavState
  anchorRect: PopoverAnchor | null
  onClose: () => void
  onOpenSettings: () => void
  onReload: () => void
}

export function SiteInfoPanel({
  state,
  anchorRect,
  onClose,
  onOpenSettings,
  onReload
}: SiteInfoPanelProps) {
  const security = state.security
  const anchor = security?.anchor ?? null
  const failure = state.failure
  const web = state.mode === 'web'

  return (
    <Popover
      title="Site information"
      subtitle={state.displayUrl || 'NCC page'}
      testId="site-info"
      anchor={anchorRect}
      widthPx={380}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-ui-11 text-[color:var(--color-muted)] underline-offset-2 hover:text-[color:var(--color-text-strong)] hover:underline"
          >
            Resolution settings
          </button>
          <button
            type="button"
            onClick={onReload}
            className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
          >
            Reload
          </button>
        </div>
      }
    >
      <div className="space-y-3 px-2 py-1.5">
        {failure ? <FailureBlock code={failure.code} message={failure.message} /> : null}

        {web ? <ClearnetBlock url={state.url || state.displayUrl} /> : null}

        {!web && security ? (
          <TransportBlock
            transport={security.transport}
            host={security.host}
            pinned={security.pinned}
            viaTor={security.viaTor || state.tor.active}
          />
        ) : null}

        {state.tor.tabTor || state.tor.onionAvailable || state.tor.active ? (
          <TorBlock
            active={state.tor.active}
            available={state.tor.onionAvailable}
            tabTor={state.tor.tabTor}
          />
        ) : null}

        {state.tabKind === 'private' ? <PrivateBlock /> : null}

        {!web && !security && !failure ? (
          <div className="flex items-start gap-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-muted)]" />
            <div>
              <p className="text-ui-12 font-medium text-[color:var(--color-text-strong)]">NCC page</p>
              <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                Resolving this address over Nostr. Transport and trust details appear
                once the document loads.
              </p>
            </div>
          </div>
        ) : null}

        {!web && security ? (
          <AnchorBlock anchor={anchor} />
        ) : null}

        {!web ? (
          <p className="border-t border-[color:var(--color-line)] pt-2 text-ui-105 leading-relaxed text-[color:var(--color-faint)]">
            The npub in the address is the trust anchor. NCC-02 adds service intent and a
            transport key; NCC-05 supplies the reachable endpoint. A conflicting transport
            key fails closed.
          </p>
        ) : null}
      </div>
    </Popover>
  )
}

function ClearnetBlock({ url }: { url: string }) {
  const state = clearnetState(url)
  const secure = state.label === 'secure'
  const insecure = state.label === 'insecure'
  const onion = state.label === 'onion'
  const Icon = onion ? Globe : secure ? Lock : insecure ? ShieldAlert : Globe
  const tone = onion
    ? state.tone === 'ok'
      ? 'text-[color:var(--color-ok)]'
      : 'text-[color:var(--color-warn)]'
    : secure
      ? 'text-[color:var(--color-ok)]'
      : insecure
        ? 'text-[color:var(--color-warn)]'
        : 'text-[color:var(--color-muted)]'
  const title = onion
    ? 'Onion service over Tor'
    : secure
      ? 'Secure HTTPS'
      : insecure
        ? 'Not secure (HTTP)'
        : 'Clearnet page'
  const hint = onion
    ? 'This .onion address is loaded through Tor. The onion address authenticates the service; HTTP inside it has no TLS layer, while HTTPS adds one.'
    : secure
      ? 'Normal CA-validated TLS. NCC resolution and NCC-02 anchoring were not involved.'
      : insecure
        ? 'This page travels over plaintext HTTP. Anyone on the network can read or modify it.'
        : 'Loaded directly from the clearnet. NCC resolution and NCC-02 anchoring were not involved.'

  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <p className={cn('flex items-center gap-1.5 text-ui-115 font-medium', tone)}>
        <Icon className="h-3.5 w-3.5" />
        {title}
      </p>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {hint}
      </p>
      {state.host ? (
        <p className="mt-1 truncate font-mono text-ui-10 text-[color:var(--color-faint)]">{state.host}</p>
      ) : null}
    </div>
  )
}

function FailureBlock({ code, message }: { code: string; message: string }) {
  const copy = ERROR_COPY[code]
  return (
    <div className="rounded-xl border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/[0.07] p-3">
      <p className="flex items-center gap-1.5 text-ui-11 font-semibold text-[color:var(--color-danger)]">
        <AlertTriangle className="h-3.5 w-3.5" />
        {copy?.title ?? 'Page failed'}
      </p>
      <p className="mt-1 font-mono text-ui-95 text-[color:var(--color-danger)]/80">{code}</p>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {copy?.hint ?? message}
      </p>
    </div>
  )
}

function TransportBlock({
  transport,
  host,
  pinned,
  viaTor
}: {
  transport: TransportSecurity
  host: string
  pinned: boolean
  viaTor: boolean
}) {
  const copy =
    transport === 'pinned-tls'
      ? {
          title: 'Pinned TLS',
          hint: viaTor
            ? 'The endpoint certificate matches the SPKI fingerprint signed into the locator. The connection runs through Tor.'
            : 'The endpoint certificate matches the SPKI fingerprint signed into the locator.',
          icon: ShieldCheck,
          tone: 'text-[color:var(--color-ok)]'
        }
      : transport === 'tls'
        ? {
            title: 'TLS',
            hint: viaTor
              ? 'TLS is active without a published fingerprint, so normal CA validation applies. The connection runs through Tor.'
              : 'TLS is active without a published fingerprint, so normal CA validation applies.',
            icon: Lock,
            tone: 'text-[color:var(--color-accent)]'
          }
        : transport === 'plaintext'
          ? {
              title: viaTor ? 'HTTP over Tor' : 'Plaintext',
              hint: viaTor
                ? 'The onion service speaks HTTP, not TLS. Tor encrypts the path to the onion service and authenticates its address, but the content itself has no TLS layer.'
                : 'The locator is signed, but page content travels over unauthenticated HTTP.',
              icon: ShieldAlert,
              tone: 'text-[color:var(--color-warn)]'
            }
          : {
              title: 'Unknown transport',
              hint: 'No transport security information is available.',
              icon: ShieldQuestion,
              tone: 'text-[color:var(--color-muted)]'
            }

  const Icon = copy.icon
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className={cn('inline-flex items-center gap-1.5 text-ui-115 font-medium', copy.tone)}>
          <Icon className="h-3.5 w-3.5" />
          {copy.title}
        </span>
        {pinned ? (
          <span className="rounded border border-[color:var(--color-ok)]/25 px-1.5 py-0.5 text-ui-95 text-[color:var(--color-ok)]">
            k verified
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {copy.hint}
      </p>
      {host ? <p className="mt-1 truncate font-mono text-ui-10 text-[color:var(--color-faint)]">{host}</p> : null}
    </div>
  )
}

function TorBlock({
  active,
  available,
  tabTor
}: {
  active: boolean
  available: boolean
  tabTor: boolean
}) {
  return (
    <div
      data-tor-block
      className={cn(
        'rounded-xl border p-3',
        active
          ? 'border-[color:var(--color-violet)]/35 bg-[color:var(--color-violet)]/[0.08]'
          : 'border-[color:var(--color-line)] bg-[color:var(--color-field)]'
      )}
    >
      <p
        className={cn(
          'flex items-center gap-1.5 text-ui-115 font-medium',
          active ? 'text-[color:var(--color-violet-text)]' : 'text-[color:var(--color-muted)]'
        )}
      >
        <Globe className="h-3.5 w-3.5" />
        {tabTor ? 'Tor tab' : active ? 'Using Tor' : 'Onion endpoint available'}
      </p>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {tabTor
          ? 'All traffic from this tab is routed through Tor. HTTP pages still have no TLS layer.'
          : active
            ? 'This page is loaded from an onion endpoint through Tor. Clearnet subresources and redirects are blocked to avoid revealing your IP.'
            : available
              ? 'This locator also publishes an onion endpoint. Use the onion button in the address bar to load it over Tor.'
              : 'This page is loaded through Tor.'}
      </p>
    </div>
  )
}

function PrivateBlock() {
  return (
    <div
      data-private-block
      className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3"
    >
      <p className="text-ui-115 font-medium text-[color:var(--color-violet-text)]">Private tab</p>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        Cookies, cache and remembered signer permissions stay in memory and are cleared when
        the last private tab closes. History is not saved.
      </p>
    </div>
  )
}

function AnchorBlock({ anchor }: { anchor: AnchorInfo | null }) {
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

  if (!record) {
    return (
      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
        <p className={cn('flex items-center gap-1.5 text-ui-115 font-medium', tone)}>
          <Icon className="h-3.5 w-3.5" />
          {labelFor(anchor)}
        </p>
        <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          No NCC-02 service record (kind 30059) was found for this service. The NCC-05
          locator is still signed by the publisher, but there is no separate service
          identity anchor.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className={cn('flex items-center gap-1.5 text-ui-115 font-medium', tone)}>
          {anchor?.fallback ? (
            <AnchorIcon className="h-3.5 w-3.5" />
          ) : (
            <Icon className="h-3.5 w-3.5" />
          )}
          {labelFor(anchor)}
        </p>
        <span className="text-ui-95 text-[color:var(--color-faint)]">
          {anchor?.required ? 'required' : 'optional'}
        </span>
      </div>

      {anchor?.fallback ? (
        <p className="mt-2 rounded-lg border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-2 py-1.5 text-ui-105 leading-relaxed text-[color:var(--color-accent)]">
          NCC-05 had no usable endpoint, so this page is served from the NCC-02 `u`
          endpoint instead.
        </p>
      ) : null}

      <dl className="mt-2 space-y-1.5">
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
      </dl>
    </div>
  )
}

function labelFor(anchor: AnchorInfo | null): string {
  switch (anchor?.status ?? 'unanchored') {
    case 'anchored':
      return anchor?.fallback ? 'Anchored · NCC-02 fallback' : 'Anchored'
    case 'expired':
      return 'Anchor expired'
    case 'invalid':
      return 'Anchor invalid'
    case 'required-missing':
      return 'No anchor'
    default:
      return 'Unanchored'
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
      <dt className="shrink-0 text-ui-10 uppercase tracking-wide text-[color:var(--color-faint)]">{label}</dt>
      <dd
        title={title}
        className={cn(
          'min-w-0 truncate text-right text-ui-105 text-[color:var(--color-text)]',
          mono && 'font-mono text-ui-10'
        )}
      >
        {value}
      </dd>
    </div>
  )
}
