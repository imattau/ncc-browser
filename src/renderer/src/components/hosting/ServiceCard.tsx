import { ExternalLink, Globe, Lock, Pencil, Radar, RefreshCw, Share2, ShieldCheck, Trash2 } from 'lucide-react'
import {
  isLoopbackEndpoint,
  isTlsProxyEndpoint,
  recipientNpub,
  type HttpsPlan,
  serviceAddress,
  type HostedService,
  type OnionStatus,
  type ServiceShare
} from '@shared/hosting'
import { cn } from '../../lib/cn'
import { relativeSeconds } from '../../lib/format'
import { SharePanel } from './SharePanel'
import { ServiceShares } from './ServiceShares'
import type { HostingSharesApi } from './useHostingShares'

interface ServiceCardProps {
  service: HostedService
  shares: ServiceShare[]
  onions: OnionStatus[] | undefined
  https: HttpsPlan | undefined
  npub: string
  identityConfigured: boolean
  busy: boolean
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  onOpen: (address: string) => void
  onPublish: (service: HostedService) => void
  onPublishOnion: (service: HostedService) => void
  onRemoveOnion: (service: HostedService) => void
  onPublishTlsProxy: (service: HostedService) => void
  onRemoveTlsProxy: (service: HostedService) => void
  onEdit: (service: HostedService) => void
  onRemove: (service: HostedService) => void
  sharesApi: HostingSharesApi
}

/** One hosted service, its onion endpoint, share panel and existing shares. */
export function ServiceCard({
  service,
  shares,
  onions,
  https,
  npub,
  identityConfigured,
  busy,
  copied,
  copy,
  onOpen,
  onPublish,
  onPublishOnion,
  onRemoveOnion,
  onPublishTlsProxy,
  onRemoveTlsProxy,
  onEdit,
  onRemove,
  sharesApi
}: ServiceCardProps) {
  const serviceNpub = service.owner ? recipientNpub(service.owner) : npub
  const address = serviceNpub ? serviceAddress(serviceNpub, service.service) : ''
  const serviceShares = shares.filter((share) => share.serviceId === service.id)
  const onion = (onions ?? []).find((entry) => entry.serviceId === service.id)
  const canOnion = service.endpoints.some((endpoint) => isLoopbackEndpoint(endpoint))
  const canShare = service.endpoints.some((endpoint) => !isLoopbackEndpoint(endpoint))
  const canHttps = service.endpoints.some(
    (endpoint) => !endpoint.url.includes('.onion') && !isTlsProxyEndpoint(endpoint)
  )
  const expired = Boolean(
    service.lastPublishedAt &&
      service.lastPublishedAt + service.ttlSeconds <= Math.floor(Date.now() / 1000)
  )

  return (
    <div
      data-hosting-service={service.service}
      className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
              {service.title}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ui-95',
                service.lastPublishError
                  ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
                  : service.lastPublishedAt && !expired
                    ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                    : 'bg-[color:var(--color-hover)] text-[color:var(--color-muted)]'
              )}
            >
              {service.lastPublishError
                ? 'publish failed'
                : expired
                  ? 'expired'
                  : service.lastPublishedAt
                    ? `published ${relativeSeconds(service.lastPublishedAt)}`
                    : 'not published'}
            </span>
            <span className="inline-flex items-center gap-1 text-ui-95 text-[color:var(--color-faint)]">
              {service.visibility === 'private' ? (
                <>
                  <Lock className="h-3 w-3" /> private
                </>
              ) : (
                <>
                  <Globe className="h-3 w-3" /> public
                </>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void copy(`address:${service.id}`, address)}
            title="Copy address"
            className="mt-1 block max-w-full truncate font-mono text-ui-105 text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
          >
            {copied === `address:${service.id}` ? 'copied' : address || 'connect an identity'}
          </button>
          {service.owner && npub && serviceNpub !== npub ? (
            <p className="mt-1 text-ui-10 text-[color:var(--color-danger)]">
              Published as a different identity. Switch back to publish or share it.
            </p>
          ) : null}
          <div className="mt-1 space-y-0.5">
            {service.endpoints.map((endpoint) => (
              <div key={endpoint.url} className="truncate font-mono text-ui-95 text-[color:var(--color-faint)]">
                {endpoint.url}
              </div>
            ))}
          </div>
          {onion ? (
            <div data-service-onion className="mt-1.5 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/40 px-2 py-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui-95 font-semibold text-[color:var(--color-text)]">Tor onion</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-ui-95',
                    onion.error
                      ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
                      : onion.verifiedAt
                        ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                        : 'bg-[color:var(--color-hover)] text-[color:var(--color-muted)]'
                  )}
                >
                  {onion.error ? 'not running' : onion.verifiedAt ? 'reachable over Tor' : 'not verified yet'}
                </span>
                <button
                  type="button"
                  onClick={() => void copy(`onion:${service.id}`, onion.url)}
                  className="min-w-0 truncate font-mono text-ui-95 text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
                >
                  {copied === `onion:${service.id}` ? 'copied' : onion.url}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveOnion(service)}
                  className="ml-auto rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                >
                  Remove
                </button>
              </div>
              {onion.error ? (
                <p className="mt-0.5 text-ui-95 text-[color:var(--color-danger)]">{onion.error}</p>
              ) : (
                <p className="mt-0.5 text-ui-95 text-[color:var(--color-faint)]">
                  Forwards to {onion.target} through the bundled Tor; the address stays the same across
                  restarts.
                </p>
              )}
            </div>
          ) : null}
          {https ? (
            <div data-service-tls-proxy className="mt-1.5 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/40 px-2 py-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui-95 font-semibold text-[color:var(--color-text)]">
                  HTTPS by this browser
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveTlsProxy(service)}
                  className="ml-auto rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                >
                  Turn off
                </button>
              </div>
              <p className="mt-0.5 text-ui-95 text-[color:var(--color-faint)]">
                Publish sends these addresses. Keep the browser running; it passes visitors to your
                HTTP server on port {https.targetPort}, which sees them as connections from this
                computer.
              </p>
              {https.endpoints.map((endpoint) => (
                <div key={endpoint.url} className="truncate font-mono text-ui-95 text-[color:var(--color-muted)]">
                  {endpoint.url}
                </div>
              ))}
              {https.routerPorts.map((port) => (
                <p key={port} data-router-forward className="mt-0.5 text-ui-95 font-semibold text-[color:var(--color-text)]">
                  For internet visitors, set your router to forward TCP port {port} to{' '}
                  {https.lanAddress ?? 'this computer'}, port {https.listenPort}.
                </p>
              ))}
            </div>
          ) : null}
          {service.lastPublishError ? (
            <p className="mt-1 text-ui-10 text-[color:var(--color-danger)]">{service.lastPublishError}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onOpen(address)}
            disabled={!address}
            className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
          >
            <ExternalLink className="h-3 w-3" /> Open
          </button>
          <button
            type="button"
            onClick={() => onPublish(service)}
            disabled={busy || !identityConfigured}
            className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
          >
            <RefreshCw className="h-3 w-3" /> Publish
          </button>
          {canOnion && !onion ? (
            <button
              type="button"
              data-publish-onion
              onClick={() => onPublishOnion(service)}
              disabled={busy}
              title="Create a Tor onion endpoint that works behind NAT"
              className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
            >
              <Radar className="h-3 w-3" /> Onion
            </button>
          ) : null}
          {canHttps && !https ? (
            <button
              type="button"
              data-publish-tls-proxy
              onClick={() => onPublishTlsProxy(service)}
              disabled={busy}
              title="Let the browser add HTTPS in front of your HTTP server, with no server setup"
              className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
            >
              <ShieldCheck className="h-3 w-3" /> HTTPS
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onEdit(service)}
            className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
          <button
            type="button"
            onClick={() => sharesApi.toggleShare(service.id)}
            disabled={service.visibility !== 'private'}
            className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
          >
            <Share2 className="h-3 w-3" /> Share
          </button>
          <button
            type="button"
            onClick={() => onRemove(service)}
            title="Remove service"
            aria-label={`Remove ${service.title}`}
            className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {sharesApi.sharing === service.id ? (
        <SharePanel
          service={service}
          canShare={canShare}
          busy={busy}
          copied={copied}
          copy={copy}
          shares={sharesApi}
        />
      ) : null}

      <ServiceShares
        service={service}
        serviceShares={serviceShares}
        serviceNpub={serviceNpub}
        busy={busy}
        copied={copied}
        copy={copy}
        onRevoke={(share) => void sharesApi.revoke(share)}
        onRenew={(target, share) => void sharesApi.renewShare(target, share)}
      />

      {service.visibility === 'public' && serviceShares.length > 0 ? (
        <p className="mt-2 text-ui-10 text-[color:var(--color-muted)]">
          This service is public, so anyone with the address can already open it. Existing
          share links stay valid until they expire.
        </p>
      ) : null}
    </div>
  )
}
