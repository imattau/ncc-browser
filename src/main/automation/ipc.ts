import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BrowserShell } from '../shell'
import type { AutomationController } from './controller'

/** Settings → Agent control. Only the trusted chrome renderer may call these. */
export function registerAutomationIpc(
  controller: AutomationController,
  deps: { shell: BrowserShell }
): void {
  const handle = <T>(channel: string, action: (...args: unknown[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
      if (event.sender !== deps.shell.window.webContents) {
        throw new Error('Agent control is only managed by the browser chrome')
      }
      return action(...args)
    })
  }

  handle('ncc:automation-state', () => controller.state())
  handle('ncc:automation-set-enabled', (value) => controller.setEnabled(value === true))
  handle('ncc:automation-regenerate', () => controller.regenerateToken())
  handle('ncc:automation-revoke', (site) =>
    controller.revoke(typeof site === 'string' ? site : null)
  )
  handle('ncc:automation-copy-command', () => {
    const command = controller.connectCommand()
    if (!command) return false
    clipboard.writeText(command)
    return true
  })
}
