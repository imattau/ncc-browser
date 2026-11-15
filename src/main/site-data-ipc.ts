/**
 * Site-data IPC. Every call is derived from the active tab in the main process; the
 * chrome renderer never supplies a URL or origin.
 */

import { ipcMain } from 'electron'
import type { BrowserShell } from './shell'
import type { SiteDataService } from './site-data'

export interface SiteDataIpcDeps {
  shell: BrowserShell
}

export function registerSiteDataIpc(service: SiteDataService, deps: SiteDataIpcDeps): void {
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean =>
    event.sender === deps.shell.window.webContents

  ipcMain.handle('ncc:site-data', (event) => {
    if (!fromChrome(event)) throw new Error('Site data is only available to the browser chrome')
    return service.describe()
  })

  ipcMain.handle('ncc:clear-site-data', (event, options: unknown) => {
    if (!fromChrome(event)) throw new Error('Site data is only available to the browser chrome')
    const value =
      options && typeof options === 'object'
        ? (options as { forgetTrust?: unknown })
        : {}
    return service.clearActiveSite({ forgetTrust: value.forgetTrust === true })
  })

  ipcMain.handle('ncc:cache-info', (event) => {
    if (!fromChrome(event)) throw new Error('Cache controls are only available to the browser chrome')
    return service.cacheInfo()
  })

  ipcMain.handle('ncc:clear-cache', (event) => {
    if (!fromChrome(event)) throw new Error('Cache controls are only available to the browser chrome')
    return service.clearCache()
  })
}
