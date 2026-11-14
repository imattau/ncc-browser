import { ipcMain } from 'electron'
import type { LocatorCacheStore } from './cache-store'
import type { ConfigStore } from './config'
import type { EndpointHealth } from './ncc/health'
import type { NccResolver } from './ncc/resolver'
import type { PinStore } from './pins'
import type { IdentityStore } from './signer/identity'
import type { PermissionStore } from './signer/permissions'
import type { BrowserShell } from './shell'

export interface IpcDeps {
  shell: BrowserShell
  config: ConfigStore
  resolver: NccResolver
  pins: PinStore
  cacheStore: LocatorCacheStore
  health: EndpointHealth
  identity: IdentityStore
  permissions: PermissionStore
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('ncc:navigate', (_event, input: unknown) => deps.shell.navigate(String(input ?? '')))

  ipcMain.handle('ncc:back', () => deps.shell.back())
  ipcMain.handle('ncc:forward', () => deps.shell.forward())
  ipcMain.handle('ncc:reload', () => deps.shell.reload())
  ipcMain.handle('ncc:stop', () => deps.shell.stop())

  ipcMain.handle('ncc:new-tab', (_event, input: unknown) =>
    deps.shell.newTab(typeof input === 'string' ? input : undefined)
  )
  ipcMain.handle('ncc:close-tab', (_event, id: unknown) =>
    deps.shell.closeTab(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:select-tab', (_event, id: unknown) => {
    if (typeof id === 'string') deps.shell.selectTab(id)
  })

  ipcMain.handle('ncc:get-state', () => deps.shell.getState())
  ipcMain.handle('ncc:get-config', () => deps.config.get())

  ipcMain.handle('ncc:set-relays', (_event, relays: unknown) => {
    try {
      const config = deps.config.setRelays(relays)
      resetCaches(deps)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-gossip', (_event, value: unknown) => {
    try {
      const config = deps.config.setGossip(value)
      resetCaches(deps)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:identity-status', () => deps.identity.status())

  ipcMain.handle('ncc:identity-import', (_event, secret: unknown) => {
    const status = deps.identity.import(String(secret ?? ''))
    deps.resolver.clearCache()
    deps.cacheStore.clear()
    return status
  })

  ipcMain.handle('ncc:identity-generate', () => {
    const status = deps.identity.generate()
    deps.resolver.clearCache()
    deps.cacheStore.clear()
    return status
  })

  ipcMain.handle('ncc:identity-remove', () => {
    const status = deps.identity.remove()
    deps.resolver.clearCache()
    deps.cacheStore.clear()
    return status
  })

  ipcMain.handle('ncc:signer-permissions', () => deps.permissions.list())

  ipcMain.handle('ncc:revoke-permission', (_event, origin: unknown) => {
    if (typeof origin === 'string') deps.permissions.revoke(origin)
    return deps.permissions.list()
  })
}

function resetCaches(deps: IpcDeps): void {
  deps.resolver.clearCache()
  deps.cacheStore.clear()
  deps.pins.clear()
  deps.health.clear()
}
