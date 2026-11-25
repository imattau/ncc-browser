import { Check, Copy, RefreshCw } from 'lucide-react'
import {
  legacyShareDTag,
  serviceAddress,
  shareStatus,
  type HostedService,
  type ServiceShare
} from '@shared/hosting'
import { shortIdentity, untilSeconds } from '../../lib/format'

interface ServiceSharesProps {
  service: HostedService
  serviceShares: ServiceShare[]
  serviceNpub: string
  busy: boolean
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  onRevoke: (share: ServiceShare) => void
  onRenew: (service: HostedService, share: ServiceShare) => void
}

/** Active, expired and revoked links for one service. */
export function ServiceShares({
  service,
  serviceShares,
  serviceNpub,
  busy,
  copied,
  copy,
  onRevoke,
  onRenew
}: ServiceSharesProps) {
  if (serviceShares.length === 0) return null

  return (
    <div className="mt-3 space-y-1.5 border-t border-[color:var(--color-line)] pt-2">
      {serviceShares.map((share) => {
        const status = shareStatus(share, Math.floor(Date.now() / 1000))
        return (
          <div key={share.id} className="flex flex-wrap items-center gap-2 text-ui-10">
            <span className="min-w-0 flex-1 truncate text-[color:var(--color-muted)]">
              {share.label || shortIdentity(share.recipientNpub || share.recipient)}
              <span className="ml-2 text-[color:var(--color-faint)]">
                {status === 'active' ? untilSeconds(share.expiresAt) : status}
              </span>
            </span>
            {status === 'active' ? (
              <>
                <button
                  type="button"
                  onClick={() => void copy(`share:${share.id}`, serviceAddress(serviceNpub, share.dTag))}
                  className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                >
                  {copied === `share:${share.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => onRevoke(share)}
                  disabled={busy}
                  className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                >
                  Revoke
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onRenew(service, share)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
              >
                <RefreshCw className="h-3 w-3" /> Renew
              </button>
            )}
            {status === 'active' &&
            share.dTag === legacyShareDTag(service.service, share.recipient) ? (
              <p data-legacy-share className="w-full text-[color:var(--color-danger)]">
                This older link’s ID can be matched to this person. To replace it, revoke it,
                renew it, then send the new link.
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
