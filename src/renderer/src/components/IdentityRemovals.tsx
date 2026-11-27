import { useState } from 'react'
import type { SyncStatus } from '@shared/sync-status'
import { messageOf, shortIdentity } from '../lib/format'
import { DANGER_BUTTON, SECONDARY_BUTTON } from './guided/ui'

interface IdentityRemovalsProps {
  status: SyncStatus | null
  apply: (next: SyncStatus) => void
  /** The list changed because a key was removed here. */
  onRemoved?: () => void
}

/** Keys held on this device that have been taken out of identity sync. */
export function IdentityRemovals({ status, apply, onRemoved }: IdentityRemovalsProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const removals = status?.identityRemovals ?? []
  if (removals.length === 0) return null

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (actionError) {
      setError(messageOf(actionError))
    } finally {
      setBusy(false)
    }
  }
  const resolve = (pubkey: string, choice: 'keep' | 'restore'): Promise<void> =>
    act(async () => apply(await window.ncc.syncIdentityRemoval(pubkey, choice)))
  const remove = async (pubkey: string): Promise<void> => {
    if (
      !window.confirm(
        'Remove this identity from this device? If this is the only copy of its key, it cannot be recovered. Make sure you have a backup if you may need it.'
      )
    ) {
      return
    }
    await act(async () => {
      await window.ncc.identityRemove(pubkey, 'device')
      apply(await window.ncc.syncStatus())
      onRemoved?.()
    })
  }

  return (
    <div data-identity-removals className="space-y-2">
      {removals.map((removal) => (
        <div
          key={removal.pubkey}
          data-identity-removal={removal.pubkey}
          className="rounded-xl border border-[color:var(--color-warn)]/40 bg-[color:var(--color-panel-raised)] p-3.5 text-ui-12 text-[color:var(--color-muted)]"
        >
          <p className="text-[color:var(--color-text-strong)]">
            <span className="font-mono">{shortIdentity(removal.npub)}</span>{' '}
            {removal.kept
              ? 'is on this device but not synced.'
              : 'was removed from identity sync. It is still on this device.'}
          </p>
          {removal.kept ? null : (
            <p className="mt-1 text-ui-115">Nothing is deleted unless you choose to remove it.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {removal.kept ? null : (
              <button type="button" disabled={busy} onClick={() => void resolve(removal.pubkey, 'keep')} className={SECONDARY_BUTTON}>
                Keep it here
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void resolve(removal.pubkey, 'restore')} className={SECONDARY_BUTTON}>
              Sync it again
            </button>
            <button type="button" disabled={busy} onClick={() => void remove(removal.pubkey)} className={DANGER_BUTTON}>
              Remove from this device
            </button>
          </div>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-ui-12 text-[color:var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
