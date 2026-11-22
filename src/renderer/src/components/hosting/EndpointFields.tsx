import { Radar } from 'lucide-react'
import type { EndpointCandidate, PortMapping, ReachabilityReport } from '@shared/reachability'
import { cn } from '../../lib/cn'
import {
  ENDPOINT_CONFIDENCE_LABEL,
  ENDPOINT_KIND_LABEL,
  type DiscoverFn,
  type DraftState,
  type ExternalChecks
} from './types'

export interface EndpointFieldsProps {
  draft: DraftState
  patchDraft: (patch: Partial<DraftState>) => void
  discovery: ReachabilityReport | null
  discoveryBusy: boolean
  discoveryError: string | null
  discoveryPort: string
  setDiscoveryPort: (value: string) => void
  localOnly: boolean
  externalChecks: ExternalChecks
  localEndpoint: EndpointCandidate | null
  externalCandidate: EndpointCandidate | null
  visibleCandidates: EndpointCandidate[]
  mapping: PortMapping | null
  mappingBusy: boolean
  verifyBusy: boolean
  onDiscover: DiscoverFn
  onLocalOnlyChange: (value: boolean) => void
  onToggleEndpoint: (url: string) => void
  onMapPort: () => void
  onUnmapPort: () => void
  onVerifyMapping: () => void
}

/** Endpoint textarea plus the local/network discovery, reachability and UPnP tools. */
export function EndpointFields({
  draft,
  patchDraft,
  discovery,
  discoveryBusy,
  discoveryError,
  discoveryPort,
  setDiscoveryPort,
  localOnly,
  externalChecks,
  localEndpoint,
  externalCandidate,
  visibleCandidates,
  mapping,
  mappingBusy,
  verifyBusy,
  onDiscover,
  onLocalOnlyChange,
  onToggleEndpoint,
  onMapPort,
  onUnmapPort,
  onVerifyMapping
}: EndpointFieldsProps) {
  const discoverPort = (): number | null => {
    const port = Number(discoveryPort)
    return discoveryPort.trim() && Number.isInteger(port) ? port : null
  }

  return (
    <div>
      <label className="block text-ui-105 text-[color:var(--color-muted)]">
        Endpoints, one per line (optional until publishing)
        <textarea
          value={draft.endpoints}
          onChange={(event) => patchDraft({ endpoints: event.target.value })}
          rows={2}
          placeholder={'https://photos.example\nhttp://abc.onion'}
          className="mt-1 w-full resize-y rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
        />
      </label>
      <div className="mt-1.5 flex flex-wrap items-end gap-2">
        <label className="text-ui-95 text-[color:var(--color-muted)]">
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={discoveryPort}
            onChange={(event) => setDiscoveryPort(event.target.value)}
            placeholder={Object.values(draft.pins).length ? '443' : '80'}
            className="ml-1.5 w-20 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2 py-1 font-mono text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
          />
        </label>
        <button
          type="button"
          data-discover-endpoints
          disabled={discoveryBusy}
          onClick={() => {
            const port = discoverPort()
            onDiscover(draft.endpoints.split('\n')[0] ?? '', {
              ...(port === null ? {} : { port }),
              secure: Object.values(draft.pins).length > 0
            })
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
        >
          <Radar className={cn('h-3.5 w-3.5', discoveryBusy && 'animate-pulse')} />
          {discoveryBusy ? 'Checking this machine…' : 'Find endpoints'}
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 text-ui-95 text-[color:var(--color-muted)]">
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(event) => onLocalOnlyChange(event.target.checked)}
            className="h-3.5 w-3.5 accent-[color:var(--color-accent)]"
          />
          Local network only
        </label>
        <span className="text-ui-10 text-[color:var(--color-faint)]">
          Scans this machine and the router; checks the TLS pin and Tor status.
        </span>
      </div>
      {discoveryError ? (
        <p className="mt-1.5 text-ui-10 text-[color:var(--color-danger)]">{discoveryError}</p>
      ) : null}
      {discovery ? (
        <div data-discovery className="mt-2 space-y-1.5 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ui-10 font-semibold text-[color:var(--color-text-strong)]">
              Detected endpoints
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-ui-95',
                  discovery.torReady
                    ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                    : 'bg-[color:var(--color-hover)] text-[color:var(--color-muted)]'
                )}
              >
                {discovery.torReady ? 'Tor running' : 'Tor off'}
              </span>
              <span className="font-mono text-ui-95 text-[color:var(--color-faint)]">
                {discovery.gateway.wanAddress
                  ? `router WAN ${discovery.gateway.wanAddress} · ${discovery.gateway.wanClass}`
                  : 'router WAN unknown'}
              </span>
            </span>
          </div>
          {discovery.candidates.length === 0 ? (
            <p className="text-ui-10 text-[color:var(--color-faint)]">
              No local candidates. Add an endpoint by hand.
            </p>
          ) : null}
          {visibleCandidates.map((candidate) => {
            const selected = draft.endpoints
              .split('\n')
              .map((line) => line.trim())
              .includes(candidate.url)
            return (
              <label
                key={candidate.url}
                data-endpoint-candidate={candidate.url}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-[color:var(--color-hover)]"
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onToggleEndpoint(candidate.url)}
                  className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-ui-105 text-[color:var(--color-text)]">
                    {candidate.url}
                  </span>
                  <span className="block text-ui-95 text-[color:var(--color-faint)]">
                    {ENDPOINT_KIND_LABEL[candidate.kind]} ·{' '}
                    {ENDPOINT_CONFIDENCE_LABEL[candidate.confidence]}
                    {candidate.note ? ` — ${candidate.note}` : ''}
                  </span>
                </span>
              </label>
            )
          })}
          {discovery.warnings.length ? (
            <ul className="space-y-0.5 border-t border-[color:var(--color-line)] pt-1.5">
              {discovery.warnings.map((warning) => (
                <li key={warning} className="text-ui-95 text-[color:var(--color-muted)]">
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}

          <div data-external-check className="space-y-1.5 border-t border-[color:var(--color-line)] pt-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ui-10 font-semibold text-[color:var(--color-text-strong)]">
                Internet reachability
              </span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-ui-95',
                  discovery.externalCheck === 'matched' || discovery.externalCheck === 'confirmed'
                    ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                    : discovery.externalCheck === 'mismatch' || discovery.externalCheck === 'error'
                      ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
                      : 'bg-[color:var(--color-hover)] text-[color:var(--color-muted)]'
                )}
              >
                {discovery.externalCheck === 'matched'
                  ? 'router confirmed'
                  : discovery.externalCheck === 'confirmed'
                    ? 'address confirmed'
                    : discovery.externalCheck === 'mismatch'
                      ? 'NAT mismatch'
                      : discovery.externalCheck === 'error'
                        ? 'check failed'
                        : discovery.externalCheck === 'declined'
                          ? 'skipped'
                          : 'not checked'}
              </span>
            </div>
            {discovery.externalAddress ? (
              <p className="font-mono text-ui-95 text-[color:var(--color-muted)]">
                Internet sees {discovery.externalAddress}
                {discovery.externalProvider ? ` · ${discovery.externalProvider}` : ''}
              </p>
            ) : null}
            {externalCandidate && !localOnly ? (
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-[color:var(--color-hover)]">
                <input
                  type="checkbox"
                  checked={draft.endpoints
                    .split('\n')
                    .map((line) => line.trim())
                    .includes(externalCandidate.url)}
                  onChange={() => onToggleEndpoint(externalCandidate.url)}
                  className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-ui-105 text-[color:var(--color-text)]">
                    Include {externalCandidate.url} in the locator
                  </span>
                  <span className="block text-ui-95 text-[color:var(--color-faint)]">
                    Public endpoint · unverified until a port is forwarded and checked
                  </span>
                </span>
              </label>
            ) : null}
            {localOnly && externalCandidate ? (
              <p className="text-ui-95 text-[color:var(--color-faint)]">
                Public address hidden by Local network only.
              </p>
            ) : null}
            {discovery.externalCheck === 'not-run' && externalChecks === 'ask' ? (
              <div className="rounded-md border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2 py-1.5">
                <p className="text-ui-95 leading-relaxed text-[color:var(--color-muted)]">
                  Confirm your public address? Nostr Navigator can contact{' '}
                  <span className="font-mono">api64.ipify.org</span>. That service sees your IP
                  address, but is not sent your npub, service name or endpoints. Recommended if
                  you want to publish a direct internet endpoint.
                </p>
                <button
                  type="button"
                  data-check-public-address
                  disabled={discoveryBusy}
                  onClick={() => {
                    const port = discoverPort()
                    onDiscover(draft.endpoints.split('\n')[0] ?? '', {
                      external: true,
                      ...(port === null ? {} : { port }),
                      secure: Object.values(draft.pins).length > 0
                    })
                  }}
                  className="mt-1 rounded border border-[color:var(--color-line)] px-2 py-0.5 text-ui-95 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
                >
                  Check public address
                </button>
              </div>
            ) : null}
            {discovery.externalCheck === 'not-run' && externalChecks === 'never' ? (
              <p className="text-ui-95 text-[color:var(--color-faint)]">
                Public address checks are off in Settings → General.
              </p>
            ) : null}
            {mapping ? (
              <div data-port-mapping className="rounded-md border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2 py-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ui-95 text-[color:var(--color-muted)]">
                    Router forwards TCP {mapping.externalPort} to {mapping.internalClient}:
                    {mapping.localPort}
                  </span>
                  <button
                    type="button"
                    disabled={mappingBusy}
                    onClick={onUnmapPort}
                    className="ml-auto rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)] disabled:opacity-50"
                  >
                    Remove mapping
                  </button>
                </div>
                <p className="break-all font-mono text-ui-95 text-[color:var(--color-faint)]">
                  {mapping.url} · removed on quit
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-ui-95',
                      mapping.verifiedAt
                        ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                        : 'bg-[color:var(--color-hover)] text-[color:var(--color-muted)]'
                    )}
                  >
                    {mapping.verifiedAt ? 'reachable from the internet (via Tor)' : 'unverified'}
                  </span>
                  <button
                    type="button"
                    data-verify-port
                    disabled={verifyBusy}
                    onClick={onVerifyMapping}
                    className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
                  >
                    {verifyBusy ? 'Checking through Tor…' : 'Check reachability'}
                  </button>
                </div>
              </div>
            ) : localEndpoint ? (
              <button
                type="button"
                data-map-port
                disabled={mappingBusy}
                onClick={onMapPort}
                className="rounded border border-[color:var(--color-line)] px-2 py-0.5 text-ui-95 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
              >
                {mappingBusy ? 'Mapping…' : 'Map a TCP port on the router (UPnP)'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
