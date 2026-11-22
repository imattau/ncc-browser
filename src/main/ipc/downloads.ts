import { ipcMain, shell } from 'electron'
import type { DownloadManager } from '../downloads'
import { isChromeSender } from './shared'

export interface DownloadIpcDeps {
  downloads: DownloadManager
}

/** Download list, cancel, reveal and clear. Chrome-only. */
export function registerDownloadIpc(deps: DownloadIpcDeps): void {
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean => isChromeSender(event)

  ipcMain.handle('ncc:get-downloads', () => deps.downloads.list())

  ipcMain.handle('ncc:cancel-download', (event, id: unknown) => {
    if (!fromChrome(event) || typeof id !== 'string') return deps.downloads.list()
    deps.downloads.cancel(id)
    return deps.downloads.list()
  })

  ipcMain.handle('ncc:reveal-download', (event, id: unknown) => {
    if (!fromChrome(event) || typeof id !== 'string') return
    const path = deps.downloads.pathFor(id)
    if (path) shell.showItemInFolder(path)
  })

  ipcMain.handle('ncc:clear-downloads', (event) => {
    if (!fromChrome(event)) return deps.downloads.list()
    return deps.downloads.clearFinished()
  })
}
