import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { requireChrome } from '../ipc-guard'
import type { BrowserShell } from '../shell'
import type { SyncService } from './service'
import { isSyncableUrl } from '@shared/sync'

/** Chrome-only. Nothing here is reachable from a page. */
export function registerSyncIpc(
  service: SyncService,
  deps: { shell: BrowserShell; openTab: (url: string) => void }
): void {
  const handle = <T>(channel: string, action: (...args: unknown[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args) => {
      requireChrome(event, 'Sync')
      return action(...args)
    })
  }

  handle('ncc:sync-status', () => service.status())
  handle('ncc:sync-now', () => service.syncNow())
  handle('ncc:sync-configure', (patch) =>
    service.configure(patch && typeof patch === 'object' ? (patch as never) : {})
  )
  handle('ncc:sync-remove-device', (id) =>
    typeof id === 'string' ? service.removeDevice(id) : service.status()
  )
  handle('ncc:sync-migrate-identities', () => service.migrateIdentities())
  handle('ncc:sync-identity-removal', (pubkey, action) =>
    typeof pubkey === 'string' && (action === 'keep' || action === 'restore')
      ? service.resolveIdentityRemoval(pubkey, action)
      : service.status()
  )
  handle('ncc:sync-reset-identity-owner', () => service.resetIdentityOwner())
  handle('ncc:sync-open-tab', (url) => {
    // Another device chose this address; it is still only an address the person clicked.
    if (isSyncableUrl(url)) deps.openTab(url.trim())
  })
}
