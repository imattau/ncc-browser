import { ExternalLink, X } from 'lucide-react'
import { serviceAddress, type ReceivedShare } from '@shared/hosting'
import { shortIdentity, untilSeconds } from '../../lib/format'

interface ReceivedSharesProps {
  received: ReceivedShare[]
  onOpen: (address: string) => void
  onForget: (id: string) => void
}

/** Services another identity encrypted to this user. */
export function ReceivedShares({ received, onOpen, onForget }: ReceivedSharesProps) {
  return (
    <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
      <div>
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Shared with me</h3>
        <p className="text-ui-105 text-[color:var(--color-muted)]">
          Services another identity encrypted to you. Opening one needs the identity it was shared with.
        </p>
      </div>
      {received.length === 0 ? (
        <p className="text-ui-11 text-[color:var(--color-faint)]">Nothing received yet.</p>
      ) : (
        <div className="space-y-1.5">
          {received.map((share) => {
            const expired = share.expiresAt <= Math.floor(Date.now() / 1000)
            return (
              <div
                key={share.id}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-[color:var(--color-field)] px-2.5 py-2 text-ui-11"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[color:var(--color-text)]">
                    {share.title || `Shared service ${share.dTag.slice(0, 18)}`}
                  </div>
                  <div className="truncate text-ui-95 text-[color:var(--color-faint)]">
                    from {shortIdentity(share.ownerNpub || share.owner)} · {untilSeconds(share.expiresAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpen(serviceAddress(share.ownerNpub || share.owner, share.dTag))}
                  disabled={expired}
                  className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
                >
                  <ExternalLink className="h-3 w-3" /> Open
                </button>
                <button
                  type="button"
                  onClick={() => onForget(share.id)}
                  className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
