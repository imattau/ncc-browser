import { ipcMain, type IpcMainInvokeEvent } from 'electron'
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
      if (event.sender !== deps.shell.window.webContents) {
        throw new Error('Sync is only available to the browser chrome')
      }
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
  handle('ncc:sync-open-tab', (url) => {
    // Another device chose this address; it is still only an address the person clicked.
    if (isSyncableUrl(url)) deps.openTab(url.trim())
  })
}
