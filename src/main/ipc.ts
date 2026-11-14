import { ipcMain } from 'electron'
import { COMMANDS, type CommandId } from '@shared/commands'
import type { LocatorCacheStore } from './cache-store'
import type { ConfigStore } from './config'
import type { EndpointHealth } from './ncc/health'
import type { NccResolver } from './ncc/resolver'
import type { PinStore } from './pins'
import type { ApprovalBroker } from './approval'
import type { IdentityManager } from './signer/manager'
import type { PermissionStore } from './signer/permissions'
import type { BrowserShell } from './shell'

export interface IpcDeps {
  shell: BrowserShell
  config: ConfigStore
  resolver: NccResolver
  pins: PinStore
  cacheStore: LocatorCacheStore
  health: EndpointHealth
  identity: IdentityManager
  permissions: PermissionStore
  approvals: ApprovalBroker
}

export function registerIpc(deps: IpcDeps): void {
  const commandIds = new Set<string>(COMMANDS.map((command) => command.id))

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

  ipcMain.handle('ncc:identity-import', async (_event, secret: unknown) => {
    const status = await deps.identity.importLocal(String(secret ?? ''))
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-generate', async () => {
    const status = await deps.identity.generateLocal()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-remove', async () => {
    const status = await deps.identity.removeLocal()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-connect-bunker', async (_event, url: unknown) => {
    const status = await deps.identity.connectRemote(String(url ?? ''))
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-disconnect', async () => {
    const status = await deps.identity.disconnectRemote()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:signer-permissions', () => deps.permissions.list())

  ipcMain.handle('ncc:revoke-permission', (_event, origin: unknown) => {
    if (typeof origin === 'string') deps.permissions.revoke(origin)
    return deps.permissions.list()
  })

  ipcMain.handle('ncc:signer-response', (event, payload: unknown) => {
    // Only the trusted chrome renderer may answer a signer request.
    if (event.sender !== deps.shell.window.webContents) return
    if (!payload || typeof payload !== 'object') return
    const { id, allow, remember } = payload as {
      id?: unknown
      allow?: unknown
      remember?: unknown
    }
    if (typeof id !== 'string') return
    deps.approvals.respond(id, { allow: allow === true, remember: remember === true })
  })

  ipcMain.handle('ncc:command', (event, command: unknown) => {
    if (event.sender !== deps.shell.window.webContents) return
    if (typeof command !== 'string' || !commandIds.has(command)) return
    deps.shell.runCommand(command as CommandId)
  })

  ipcMain.handle('ncc:set-overlay', (event, payload: unknown) => {
    if (event.sender !== deps.shell.window.webContents) return
    if (!payload || typeof payload !== 'object') return
    const { reason, active } = payload as { reason?: unknown; active?: unknown }
    if (reason !== 'menu') return
    deps.shell.setOverlay('menu', active === true)
  })
}

function resetCaches(deps: IpcDeps): void {
  deps.resolver.clearCache()
  deps.cacheStore.clear()
  deps.pins.clear()
  deps.health.clear()
}
