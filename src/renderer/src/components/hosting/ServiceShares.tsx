import { Check, Copy, RefreshCw } from 'lucide-react'
import { contactLabel, type ContactProfile } from '@shared/contacts'
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
  contacts: ContactProfile[]
  onRevoke: (share: ServiceShare) => void
  onForget: (share: ServiceShare) => void
  onRenew: (service: HostedService, share: ServiceShare) => void
}

/** Who has, or had, a link to one service. */
export function ServiceShares({
  service,
  serviceShares,
  serviceNpub,
  busy,
  copied,
  copy,
  contacts,
  onRevoke,
  onForget,
  onRenew
}: ServiceSharesProps) {
  if (serviceShares.length === 0) return null

  return (
    <div className="mt-3 space-y-1.5 border-t border-[color:var(--color-line)] pt-2">
      <p className="text-ui-10 font-medium text-[color:var(--color-text)]">People with a link</p>
      {serviceShares.map((share) => {
        const status = shareStatus(share, Math.floor(Date.now() / 1000))
        const contact = contacts.find((entry) => entry.pubkey === share.recipient)
        const person = contact
          ? contactLabel(contact)
          : shortIdentity(share.recipientNpub || share.recipient)
        return (
          <div key={share.id} className="flex flex-wrap items-center gap-2 text-ui-10">
            <span className="min-w-0 flex-1 truncate text-[color:var(--color-muted)]">
              {share.label ? `${person} · ${share.label}` : person}
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
                  Remove access
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onRenew(service, share)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                >
                  <RefreshCw className="h-3 w-3" /> {status === 'revoked' ? 'Add again' : 'Renew'}
                </button>
                {status === 'revoked' ? (
                  <button
                    type="button"
                    onClick={() => onForget(share)}
                    disabled={busy}
                    className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                  >
                    Delete from list
                  </button>
                ) : null}
              </>
            )}
            {status === 'active' &&
            share.dTag === legacyShareDTag(service.service, share.recipient) ? (
              <p data-legacy-share className="w-full text-[color:var(--color-danger)]">
                This older link’s ID can be matched to this person. To replace it, remove access,
                add them again, then send the new link.
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
