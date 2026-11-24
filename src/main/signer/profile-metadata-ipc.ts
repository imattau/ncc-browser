import { ipcMain } from 'electron'
import type { IdentityProfileMetadataService } from './profile-metadata'
import type { BrowserShell } from '../shell'

export function registerIdentityProfileMetadataIpc(
  service: IdentityProfileMetadataService,
  shell: BrowserShell
): void {
  const fromChrome = (sender: Electron.WebContents): boolean =>
    !shell.window.isDestroyed() && sender === shell.window.webContents

  ipcMain.handle('ncc:identity-profile-metadata', (event, pubkeys: unknown) => {
    if (!fromChrome(event.sender)) throw new Error('Identity profiles are only available to the browser chrome')
    return service.get(pubkeys)
  })
}
