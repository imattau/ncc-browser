import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { requireChrome } from '../ipc-guard'
import type { BrowserShell } from '../shell'
import type { AutomationController } from './controller'

/** Settings → Agent control. Only the trusted chrome renderer may call these. */
export function registerAutomationIpc(
  controller: AutomationController,
  deps: { shell: BrowserShell }
): void {
  const handle = <T>(channel: string, action: (...args: unknown[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
      requireChrome(event, 'Agent control')
      return action(...args)
    })
  }

  handle('ncc:automation-state', () => controller.state())
  handle('ncc:automation-set-enabled', (value) => controller.setEnabled(value === true))
  handle('ncc:automation-add-agent', (name) => controller.addAgent(typeof name === 'string' ? name : 'Agent'))
  handle('ncc:automation-remove-agent', (id) => controller.removeAgent(String(id)))
  handle('ncc:automation-regenerate-identity', (id) => controller.regenerateIdentity(String(id)))
  handle('ncc:automation-revoke', (agentId, site) =>
    controller.revoke(String(agentId), typeof site === 'string' ? site : null)
  )
  handle('ncc:automation-reveal-command', (agentId) => controller.revealCommand(String(agentId)))
  handle('ncc:automation-copy-command', (command) => {
    if (typeof command !== 'string' || !command) return false
    clipboard.writeText(command)
    return true
  })
}
