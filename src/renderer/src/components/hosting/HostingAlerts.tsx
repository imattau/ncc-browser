import type { NetworkChange, PortStatusEvent } from '@shared/reachability'

interface HostingAlertsProps {
  portAlerts: PortStatusEvent[]
  networkChanges: NetworkChange[]
  busy: boolean
  verifyBusy: boolean
  onRecheckPort: (localPort: number) => void
  onDismissPort: (localPort: number) => void
  onAcceptNetworkChange: (change: NetworkChange, publish?: boolean) => void
  onDismissNetworkChange: (change: NetworkChange) => void
}

/** Port failures and address changes that need the user's attention. */
export function HostingAlerts({
  portAlerts,
  networkChanges,
  busy,
  verifyBusy,
  onRecheckPort,
  onDismissPort,
  onAcceptNetworkChange,
  onDismissNetworkChange
}: HostingAlertsProps) {
  return (
    <>
      {portAlerts.map((alert) => (
        <div
          key={`${alert.mapping.localPort}:${alert.mapping.externalPort}`}
          data-port-alert
          className="rounded-xl border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 p-3 text-ui-11"
        >
          <p className="font-medium text-[color:var(--color-text-strong)]">
            Mapped port {alert.mapping.externalPort} stopped answering
          </p>
          <p className="mt-0.5 break-all font-mono text-ui-105 text-[color:var(--color-muted)]">
            {alert.mapping.externalAddress}:{alert.mapping.externalPort} →{' '}
            {alert.mapping.internalClient}:{alert.mapping.localPort}
          </p>
          <p className="mt-0.5 text-ui-105 text-[color:var(--color-muted)]">
            The router mapping may have expired, or the service behind it stopped. Traffic
            through Tor did not reach it twice in a row.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={verifyBusy}
              onClick={() => onRecheckPort(alert.mapping.localPort)}
              className="rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1 text-ui-105 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
            >
              Check again
            </button>
            <button
              type="button"
              onClick={() => onDismissPort(alert.mapping.localPort)}
              className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {networkChanges.map((change) => (
        <div
          key={`${change.interface}:${change.from}:${change.to}`}
          data-network-change
          className="rounded-xl border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 p-3 text-ui-11"
        >
          <p className="font-medium text-[color:var(--color-text-strong)]">
            {change.interface === 'WAN'
              ? 'The router public WAN address changed'
              : `This machine's ${change.family === 'ipv4' ? 'IPv4' : 'IPv6'} address changed on ${change.interface}`}
          </p>
          <p className="mt-0.5 break-all font-mono text-ui-105 text-[color:var(--color-muted)]">
            {change.from} → {change.to}
          </p>
          <p className="mt-0.5 text-ui-105 text-[color:var(--color-muted)]">
            Services that published the old address stop resolving. Replacing the address and
            republishing needs a signature; a remote signer may ask for approval.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAcceptNetworkChange(change, true)}
              title="Replace the address, sign and publish each changed service. A remote signer may ask for approval."
              className="rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1 text-ui-105 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
            >
              Update &amp; republish
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAcceptNetworkChange(change)}
              className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-105 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
            >
              Update endpoints only
            </button>
            <button
              type="button"
              onClick={() => onDismissNetworkChange(change)}
              className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </>
  )
}
