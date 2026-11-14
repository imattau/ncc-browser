import { ipcMain } from 'electron'
import type { ConfigStore } from './config'
import type { NccResolver } from './ncc/resolver'
import type { PinStore } from './pins'
import type { BrowserShell } from './shell'

export interface IpcDeps {
  shell: BrowserShell
  config: ConfigStore
  resolver: NccResolver
  pins: PinStore
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('ncc:navigate', (_event, input: unknown) => deps.shell.navigate(String(input ?? '')))

  ipcMain.handle('ncc:back', () => deps.shell.back())
  ipcMain.handle('ncc:forward', () => deps.shell.forward())
  ipcMain.handle('ncc:reload', () => deps.shell.reload())
  ipcMain.handle('ncc:stop', () => deps.shell.stop())

  ipcMain.handle('ncc:get-state', () => deps.shell.getState())
  ipcMain.handle('ncc:get-config', () => deps.config.get())

  ipcMain.handle('ncc:set-relays', (_event, relays: unknown) => {
    try {
      const config = deps.config.setRelays(relays)
      deps.resolver.clearCache()
      deps.pins.clear()
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
