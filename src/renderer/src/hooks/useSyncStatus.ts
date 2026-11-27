import { useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '@shared/sync-status'

/** Sync as it stands, kept up to date. */
export function useSyncStatus(): [SyncStatus | null, (next: SyncStatus) => void] {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.ncc.onSyncStatus((next) => alive && setStatus(next))
    void window.ncc.syncStatus().then((next) => alive && setStatus((current) => current ?? next))
    return () => {
      alive = false
      off()
    }
  }, [])
  return [status, setStatus]
}

/** Calls `reload` when sync adds an identity, so a list on screen does not go stale. */
export function useReloadOnSyncedIdentity(reload: () => void): void {
  const [status] = useSyncStatus()
  const revision = status?.identityRevision
  const seen = useRef<number | undefined>(undefined)
  const latest = useRef(reload)
  latest.current = reload
  useEffect(() => {
    if (revision === undefined) return
    // The first value counts too: a key may have arrived while the list was loading.
    if (seen.current !== revision && (seen.current !== undefined || revision > 0)) latest.current()
    seen.current = revision
  }, [revision])
}
