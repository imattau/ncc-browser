import { ipcMain } from 'electron'
import type { BrowserShell } from '../shell'
import type { ContactsService } from './service'

/** Contact lists are only exposed to the browser chrome. */
export function registerContactsIpc(service: ContactsService, shell: BrowserShell): void {
  const fromChrome = (sender: Electron.WebContents): boolean =>
    !shell.window.isDestroyed() && sender === shell.window.webContents

  ipcMain.handle('ncc:contacts-state', (event) => {
    if (!fromChrome(event.sender)) throw new Error('Contacts are only available to the browser chrome')
    return service.state()
  })

  ipcMain.handle('ncc:contacts-refresh', async (event) => {
    if (!fromChrome(event.sender)) throw new Error('Contacts are only available to the browser chrome')
    try {
      await service.refresh()
    } catch {
      // state() carries the error for the UI.
    }
    return service.state()
  })
}
