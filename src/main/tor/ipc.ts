import { ipcMain } from 'electron'
import type { ConfigStore } from '../config'
import type { TransportPolicy } from '../ncc/transport'
import { browserShells } from '../shell'
import type { TorManager } from './manager'
import { normalizeTorProxy } from './proxy'

export interface TorIpcDeps {
  config: ConfigStore
  tor: TorManager
  transport: TransportPolicy
}

/** Tor runtime settings and lifecycle, plus the status the chrome polls. */
export function registerTorIpc(deps: TorIpcDeps): void {
  const failure = (error: unknown): { ok: false; error: string } => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })

  ipcMain.handle('ncc:set-tor-mode', async (event, value: unknown) => {
    try {
      const config = deps.config.setTorMode(value)
      await deps.tor.reset()
      deps.transport.clear()
      for (const browserShell of browserShells()) browserShell.applyTorPreference()
      return { ok: true, config }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('ncc:set-tor-socks', async (event, value: unknown) => {
    try {
      const normalized = normalizeTorProxy(value)
      const config = deps.config.setTorSocks(normalized)
      await deps.tor.reset()
      deps.transport.clear()
      for (const browserShell of browserShells()) browserShell.applyTorPreference()
      return { ok: true, config }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('ncc:set-tor-config', async (event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid Tor settings' }
      }
      const { preferTor, mode, socks } = payload as {
        preferTor?: unknown
        mode?: unknown
        socks?: unknown
      }
      const normalized = normalizeTorProxy(socks)
      const before = deps.config.get()
      deps.config.setPreferTor(preferTor === true)
      deps.config.setTorMode(mode === 'local' ? 'local' : 'auto')
      const config = deps.config.setTorSocks(normalized)

      const changed =
        before.preferTor !== config.preferTor ||
        before.torMode !== config.torMode ||
        before.torSocks !== config.torSocks
      if (!changed) return { ok: true, config }

      if (before.torMode !== config.torMode || before.torSocks !== config.torSocks) {
        await deps.tor.reset()
      }
      deps.transport.clear()
      for (const browserShell of browserShells()) browserShell.applyTorPreference()
      if (config.preferTor) void deps.tor.ensureReady().catch(() => undefined)
      return { ok: true, config }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('ncc:tor-status', () => deps.tor.status())
  ipcMain.handle('ncc:tor-test', () => deps.tor.test())
  ipcMain.handle('ncc:tor-restart', async () => {
    await deps.tor.reset()
    deps.transport.clear()
    for (const browserShell of browserShells()) browserShell.applyTorPreference()
    return deps.tor.test()
  })
}
