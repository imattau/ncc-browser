import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Anchor as AnchorIcon,
  Clock,
  Cookie,
  Globe,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Trash2
} from 'lucide-react'
import { ERROR_COPY } from '@shared/types'
import type { SiteDataInfo } from '@shared/site-data'
import type { AnchorInfo, LocatorInfo, NavState, SignerOriginState, TransportSecurity } from '@shared/types'
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
  const [signerOrigin, setSignerOrigin] = useState<SignerOriginState | null>(null)
  const [protectionException, setProtectionException] = useState(false)
  const [protectionSummary, setProtectionSummary] = useState<{ level: string; blocked: number; excepted: boolean } | null>(null)

  const pageUrl = state.url || state.displayUrl
  useEffect(() => {
    if (!pageUrl) {
      setSignerOrigin(null)
      return
    }
    let alive = true
    void window.ncc
      .signerOrigin(pageUrl)
      .then((next) => {
        if (alive) setSignerOrigin(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [pageUrl])

  useEffect(() => {
    if (!web || !pageUrl) { setProtectionException(false); return }
    let alive = true
    void window.ncc.protectionSummary(pageUrl, state.tabKind).then((summary) => {
      if (!alive) return
      setProtectionException(summary.excepted)
      setProtectionSummary(summary)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [pageUrl, web, state.tabKind])

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
        {web && protectionSummary ? (
          <p className="text-ui-11 text-[color:var(--color-muted)]">
            Protection: {protectionSummary.excepted ? 'allowed for this site' : protectionSummary.level} · {protectionSummary.blocked} blocked this session
          </p>
        ) : null}
        {web && /^https?:/i.test(pageUrl) ? (
          <button
            type="button"
            onClick={() => {
              let origin = ''
              try { origin = new URL(pageUrl).origin } catch { return }
              void window.ncc.setProtectionException(origin, !protectionException, state.tabKind).then(() => {
                setProtectionException(!protectionException)
              })
            }}
            className="w-full rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-left text-ui-12 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
          >
            {protectionException ? 'Restore tracker and ad protection for this site' : 'Allow trackers and ads on this site'}
          </button>
        ) : null}
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

        {security?.manifest ? (
          <NsiteBlock info={security.manifest} address={pageUrl} />
        ) : null}

        {signerOrigin && !state.tor.tabTor ? (
          <SignerAccessBlock
            state={signerOrigin}
            onChange={(trusted) => {
              const url = state.url || state.displayUrl
              void window.ncc
                .setSignerTrust(url, trusted)
                .then((next) => next && setSignerOrigin(next))
                .catch(() => undefined)
            }}
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

        <SiteDataBlock />

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

        {!web && security && security.transport !== 'nsite' ? (
          <AnchorBlock anchor={anchor} />
        ) : null}

        {!web && security?.locator ? (
          <LocatorBlock locator={security.locator} onClose={onClose} />
        ) : null}

        {!web ? (
          <p className="border-t border-[color:var(--color-line)] pt-2 text-ui-105 leading-relaxed text-[color:var(--color-faint)]">
            {security?.transport === 'nsite'
              ? 'The manifest signature and event ordering decide what this site is; each file is checked against its sha256 before it is served.'
              : 'The npub in the address is the trust anchor. NCC-02 adds service intent and a transport key; NCC-05 supplies the reachable endpoint. A conflicting transport key fails closed.'}
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
        : transport === 'nsite'
        ? {
            title: 'Nostr site',
            hint: 'Files came from Blossom and match the sha256 in a signed NIP-5A manifest. No server identity is trusted.',
            icon: Globe,
            tone: 'text-[color:var(--color-ok)]'
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

function NsiteBlock({
  info,
  address
}: {
  info: NonNullable<NavState['security']>['manifest']
  address: string
}) {
  if (!info) return null
  const updated = new Date(info.updatedAt * 1000)
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-ui-12 font-medium text-[color:var(--color-text-strong)]">
            {info.title || (info.site ? `${info.site} (named site)` : 'Root site')}
          </p>
          <p className="mt-0.5 truncate font-mono text-ui-10 text-[color:var(--color-faint)]">
            {address}
          </p>
        </div>
        <span className="shrink-0 rounded border border-[color:var(--color-ok)]/25 px-1.5 py-0.5 text-ui-95 text-[color:var(--color-ok)]">
          hash verified
        </span>
      </div>
      {info.description ? (
        <p className="mt-2 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          {info.description}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-2 gap-1 text-ui-10">
        <div>
          <dt className="text-[color:var(--color-muted)]">Files</dt>
          <dd className="font-mono text-[color:var(--color-text-soft)]">{info.files}</dd>
        </div>
        <div>
          <dt className="text-[color:var(--color-muted)]">Updated</dt>
          <dd className="font-mono text-[color:var(--color-text-soft)]">
            {Number.isNaN(updated.getTime()) ? '—' : updated.toISOString().slice(0, 10)}
          </dd>
        </div>
        <div>
          <dt className="text-[color:var(--color-muted)]">Blossom servers</dt>
          <dd className="font-mono text-[color:var(--color-text-soft)]">
            {info.servers.length || 'from 10063'}
          </dd>
        </div>
        <div>
          <dt className="text-[color:var(--color-muted)]">Manifest</dt>
          <dd className="font-mono text-[color:var(--color-text-soft)]">
            {info.eventId.slice(0, 10)}…
          </dd>
        </div>
      </dl>
      {info.aggregate ? (
        <p className="mt-1 truncate font-mono text-ui-10 text-[color:var(--color-faint)]">
          aggregate {info.aggregate.slice(0, 16)}…
        </p>
      ) : null}
      {info.source ? (
        <p className="mt-1 truncate text-ui-10 text-[color:var(--color-faint)]">{info.source}</p>
      ) : null}
    </div>
  )
}

function SignerAccessBlock({
  state,
  onChange
}: {
  state: SignerOriginState
  onChange: (trusted: boolean) => void
}) {
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-ui-115 font-medium',
            state.trusted ? 'text-[color:var(--color-ok)]' : 'text-[color:var(--color-muted)]'
          )}
        >
          <KeyRound className="h-3.5 w-3.5" />
          NIP-07 signer
        </span>
        <span className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)]">
          {state.trusted ? 'trusted' : 'asks each time'}
        </span>
      </div>
      <p className="mt-1 break-all text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {state.trusted
          ? 'This service can read your public key, sign events and decrypt messages without asking. Revoke it if you no longer trust the publisher.'
          : 'Every signing and decryption request asks first. Your public key and relay logins are remembered for the session once you allow them.'}
      </p>
      <button
        type="button"
        data-signer-trust-toggle
        onClick={() => onChange(!state.trusted)}
        className="mt-2 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
      >
        {state.trusted ? 'Revoke signer access' : 'Trust this service'}
      </button>
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

function LocatorBlock({
  locator,
  onClose
}: {
  locator: LocatorInfo
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reResolve = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ok = await window.ncc.reResolveSite()
      if (!ok) {
        setError('This page has no locator to refresh')
        return
      }
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const source = locator.fallback ? 'NCC-02 anchor' : locator.stale ? 'Cached copy' : 'Relays'
  const expired = locator.expiresAt <= Math.floor(Date.now() / 1000)

  return (
    <div
      data-locator
      className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3"
    >
      <p className="flex items-center gap-1.5 text-ui-115 font-medium text-[color:var(--color-text-strong)]">
        <Clock className="h-3.5 w-3.5 text-[color:var(--color-muted)]" />
        Locator record
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ui-11">
        <div>
          <dt className="text-[color:var(--color-faint)]">d tag</dt>
          <dd className="truncate font-mono text-ui-105 text-[color:var(--color-text-soft)]" data-locator-d-tag>
            {locator.dTag}
          </dd>
        </div>
        <div>
          <dt className="text-[color:var(--color-faint)]">Published</dt>
          <dd className="text-[color:var(--color-text-soft)]" data-locator-age>
            {timeAgo(locator.updatedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-[color:var(--color-faint)]">Expires</dt>
          <dd
            className={
              expired
                ? 'text-[color:var(--color-danger)]'
                : 'text-[color:var(--color-text-soft)]'
            }
          >
            {timeLeft(locator.expiresAt)}
          </dd>
        </div>
        <div>
          <dt className="text-[color:var(--color-faint)]">Source</dt>
          <dd className="text-[color:var(--color-text-soft)]" data-locator-source>
            {source}
          </dd>
        </div>
      </dl>

      {locator.fallback ? (
        <p className="mt-2 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
          No usable NCC-05 locator was found, so this endpoint comes from the NCC-02
          anchor. The browser keeps checking for a real locator in the background.
        </p>
      ) : locator.stale ? (
        <p className="mt-2 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
          Using the cached record. Relays have not confirmed it since the last check, so a
          rotation may not be visible yet.
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-re-resolve
          disabled={busy}
          onClick={() => void reResolve()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
          {busy ? 'Re-resolving…' : 'Re-resolve'}
        </button>
        <span className="text-ui-105 text-[color:var(--color-faint)]">
          Asks relays for this service again.
        </span>
      </div>
      {error ? (
        <p className="mt-1.5 text-ui-105 leading-relaxed text-[color:var(--color-danger)]">{error}</p>
      ) : null}
    </div>
  )
}

function timeAgo(unix: number): string {
  const seconds = Math.floor(Date.now() / 1000) - unix
  if (!Number.isFinite(seconds) || seconds <= 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

function timeLeft(unix: number): string {
  const seconds = unix - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 60) return `in ${seconds}s`
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`
  return `in ${Math.round(seconds / 86_400)} d`
}

function SiteDataBlock() {
  const [info, setInfo] = useState<SiteDataInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [forgetTrust, setForgetTrust] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.ncc
      .siteData()
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (!info?.supported) return null

  const hasTrust = info.hasHttpException || info.signerTrusted || info.passwordNeverSave
  const ncc = info.origin.startsWith('ncc://')

  const clear = async (): Promise<void> => {
    if (!confirm) {
      setConfirm(true)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const outcome = await window.ncc.clearSiteData({ forgetTrust })
      if (!outcome.ok) {
        setError(outcome.error ?? 'Could not clear site data')
        return
      }
      setConfirm(false)
      setForgetTrust(false)
      setNotice(outcome.trustCleared ? 'Cleared data and trust. Reloading…' : 'Cleared. Reloading…')
      setInfo(await window.ncc.siteData())
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-site-data
      className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3"
    >
      <p className="flex items-center gap-1.5 text-ui-115 font-medium text-[color:var(--color-text-strong)]">
        <Cookie className="h-3.5 w-3.5 text-[color:var(--color-muted)]" />
        Cookies and site data
      </p>
      <p className="mt-1 truncate font-mono text-ui-10 text-[color:var(--color-faint)]" data-site-origin>
        {info.label || info.origin}
      </p>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]" data-site-cookies>
        {info.cookies == null
          ? 'Cookies, local storage, IndexedDB and service workers.'
          : `${info.cookies} cookie${info.cookies === 1 ? '' : 's'} plus local storage, IndexedDB and service workers.`}
      </p>
      {ncc ? (
        <p className="mt-1 text-ui-105 leading-relaxed text-[color:var(--color-faint)]">
          Local storage is keyed by identity, so this covers every service published by this
          npub.
        </p>
      ) : null}
      {info.endpointCookies && info.cookieHost ? (
        <p className="mt-1 text-ui-105 leading-relaxed text-[color:var(--color-faint)]">
          Server cookies belong to the endpoint host{' '}
          <span className="font-mono text-[color:var(--color-muted)]">{info.cookieHost}</span>, so
          clearing them also signs out other services served by that host.
        </p>
      ) : null}
      {info.ephemeral ? (
        <p className="mt-1 text-ui-105 leading-relaxed text-[color:var(--color-faint)]">
          This session is already wiped when the last {info.tabKind === 'tor' ? 'Tor' : 'private'}{' '}
          tab closes.
        </p>
      ) : null}

      {hasTrust ? (
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-ui-11 text-[color:var(--color-muted)]">
          <input
            type="checkbox"
            data-forget-trust
            checked={forgetTrust}
            onChange={(event) => setForgetTrust(event.target.checked)}
            disabled={busy}
            className="mt-0.5 h-3 w-3 accent-[color:var(--color-accent)]"
          />
          <span>
            Also forget trust decisions for this site
            <span className="mt-0.5 block text-ui-100 leading-relaxed text-[color:var(--color-faint)]">
              {trustSummary(info)}
            </span>
          </span>
        </label>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-clear-site-data
          disabled={busy}
          onClick={() => void clear()}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-ui-11 disabled:opacity-40',
            confirm
              ? 'border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
              : 'border-[color:var(--color-line)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]'
          )}
        >
          <Trash2 className="h-3 w-3" />
          {busy ? 'Clearing…' : confirm ? 'Click again to clear' : 'Clear site data'}
        </button>
        {confirm ? (
          <button
            type="button"
            onClick={() => setConfirm(false)}
            className="text-ui-105 text-[color:var(--color-muted)] underline-offset-2 hover:text-[color:var(--color-text-strong)] hover:underline"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-1.5 text-ui-105 leading-relaxed text-[color:var(--color-danger)]">{error}</p>
      ) : notice ? (
        <p className="mt-1.5 text-ui-105 leading-relaxed text-[color:var(--color-ok)]">{notice}</p>
      ) : null}
    </div>
  )
}

function trustSummary(info: SiteDataInfo): string {
  const parts: string[] = []
  if (info.hasHttpException) parts.push('the HTTP exception')
  if (info.signerTrusted) parts.push('“Always allow” signing')
  if (info.passwordNeverSave) parts.push('the password never-save rule')
  return `Removes ${parts.join(', ')}.`
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
