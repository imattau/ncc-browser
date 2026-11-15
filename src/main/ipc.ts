import { ipcMain, shell } from 'electron'
import { COMMANDS, type CommandId } from '@shared/commands'
import { OVERLAY_REASONS } from '@shared/types'
import type { LocatorCacheStore } from './cache-store'
import type { ConfigStore } from './config'
import type { DownloadManager } from './downloads'
import type { EndpointHealth } from './ncc/health'
import type { NccResolver } from './ncc/resolver'
import type { TransportPolicy } from './ncc/transport'
import { normalizeTorProxy } from './tor/proxy'
import { isSearchEngineId, searxTemplate, validateSearchTemplate } from '@shared/search'
import type { TorManager } from './tor/manager'
import type { PinStore } from './pins'
import type { RelayLocatorService } from './relay/locator'
import type { RelayPool } from './relay/pool'
import type { RelayPinStore } from './relay/socket'
import type { ApprovalBroker } from './approval'
import type { IdentityManager } from './signer/manager'
import type { PermissionStore } from './signer/permissions'
import type { BrowserShell } from './shell'

export interface IpcDeps {
  shell: BrowserShell
  config: ConfigStore
  resolvers: NccResolver[]
  pins: PinStore
  relayPins: RelayPinStore
  relayLocator: RelayLocatorService
  relayPool: RelayPool
  cacheStore: LocatorCacheStore
  health: EndpointHealth
  transport: TransportPolicy
  tor: TorManager
  identity: IdentityManager
  permissions: PermissionStore
  approvals: ApprovalBroker
  downloads: DownloadManager
}

export function registerIpc(deps: IpcDeps): void {
  const commandIds = new Set<string>(COMMANDS.map((command) => command.id))
  const overlayReasons = new Set<string>(OVERLAY_REASONS)
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean =>
    event.sender === deps.shell.window.webContents

  ipcMain.handle('ncc:navigate', (_event, input: unknown) => deps.shell.navigate(String(input ?? '')))

  ipcMain.handle('ncc:back', () => deps.shell.back())
  ipcMain.handle('ncc:forward', () => deps.shell.forward())
  ipcMain.handle('ncc:reload', () => deps.shell.reload())
  ipcMain.handle('ncc:force-reload', () => deps.shell.forceReload())
  ipcMain.handle('ncc:stop', () => deps.shell.stop())
  ipcMain.handle('ncc:toggle-tor', (event) => {
    if (!fromChrome(event)) return
    deps.shell.toggleTor()
  })
  ipcMain.handle('ncc:insecure-choice', (event, choice: unknown) => {
    if (!fromChrome(event)) return
    if (choice !== 'cancel' && choice !== 'continue' && choice !== 'always') return
    deps.shell.insecureChoice(choice)
  })

  ipcMain.handle('ncc:new-tab', (_event, input: unknown) =>
    deps.shell.newTab(typeof input === 'string' ? input : undefined)
  )
  ipcMain.handle('ncc:new-private-tab', (event, input: unknown) => {
    if (!fromChrome(event)) return ''
    return deps.shell.newPrivateTab(typeof input === 'string' ? input : undefined)
  })
  ipcMain.handle('ncc:new-tor-tab', (event, input: unknown) => {
    if (!fromChrome(event)) return ''
    return deps.shell.newTorTab(typeof input === 'string' ? input : undefined)
  })
  ipcMain.handle('ncc:close-tab', (_event, id: unknown) =>
    deps.shell.closeTab(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:select-tab', (_event, id: unknown) => {
    if (typeof id === 'string') deps.shell.selectTab(id)
  })
  ipcMain.handle('ncc:move-tab', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { id, toIndex } = payload as { id?: unknown; toIndex?: unknown }
    if (typeof id !== 'string' || typeof toIndex !== 'number') return
    deps.shell.moveTab(id, toIndex)
  })
  ipcMain.handle('ncc:duplicate-tab', (event, id: unknown) => {
    if (!fromChrome(event)) return
    deps.shell.duplicateTab(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:reload-tab', (event, id: unknown) => {
    if (!fromChrome(event)) return
    deps.shell.reloadTab(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:toggle-mute', (event, id: unknown) => {
    if (!fromChrome(event)) return
    deps.shell.toggleMute(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:close-other-tabs', (event, id: unknown) => {
    if (!fromChrome(event)) return
    deps.shell.closeOtherTabs(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:close-tabs-right', (event, id: unknown) => {
    if (!fromChrome(event)) return
    deps.shell.closeTabsToRight(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:tab-menu', (event, id: unknown) => {
    if (!fromChrome(event) || typeof id !== 'string') return
    deps.shell.showTabMenu(id)
  })

  ipcMain.handle('ncc:tab-history', (_event, id: unknown) =>
    deps.shell.getTabHistory(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:go-history-index', (event, index: unknown) => {
    if (!fromChrome(event) || typeof index !== 'number') return
    deps.shell.goToHistoryIndex(index)
  })
  ipcMain.handle('ncc:clear-history', (event) => {
    if (!fromChrome(event)) return
    deps.shell.clearHistory()
  })
  ipcMain.handle('ncc:history-menu', (event, direction: unknown) => {
    if (!fromChrome(event)) return
    if (direction !== 'back' && direction !== 'forward') return
    deps.shell.showHistoryMenu(direction)
  })

  ipcMain.handle('ncc:get-state', () => deps.shell.getState())
  ipcMain.handle('ncc:get-config', () => deps.config.get())

  ipcMain.handle('ncc:omnibox-suggest', (event, input: unknown) => {
    if (!fromChrome(event)) return []
    return deps.shell.suggest(typeof input === 'string' ? input : '')
  })

  ipcMain.handle('ncc:clear-browsing-history', (event) => {
    if (!fromChrome(event)) return
    deps.shell.clearBrowsingHistory()
  })

  ipcMain.handle('ncc:set-search-config', (_event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid search settings' }
      }
      const { engine, custom, useOnionSearch } = payload as {
        engine?: unknown
        custom?: unknown
        useOnionSearch?: unknown
      }
      if (!isSearchEngineId(engine)) {
        return { ok: false, error: 'Choose a search engine' }
      }
      const template = typeof custom === 'string' ? custom : ''
      if (engine === 'searx') {
        const result = searxTemplate(template)
        if (!result.ok) return { ok: false, error: result.error }
      } else if (engine === 'custom') {
        const result = validateSearchTemplate(template)
        if (!result.ok) return { ok: false, error: result.error }
      }
      const config = deps.config.setSearchConfig({ engine, custom: template, useOnionSearch })
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-relays', (_event, relays: unknown) => {
    try {
      const previous = deps.config.getRelayEntries()
      const config = deps.config.setRelays(relays)
      deps.relayPins.setFromEntries([...config.relays, ...deps.identity.relayEntries()])
      // Drop connections that pointed at an endpoint the user removed.
      const next = new Set(config.relays.map((entry) => entry.url))
      deps.relayPool.closeUrls(previous.map((entry) => entry.url).filter((url) => !next.has(url)))
      resetCaches(deps)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:resolve-relay-locator', async (_event, input: unknown) => {
    if (typeof input !== 'string') {
      return { ok: false, code: 'invalid-address', error: 'Enter an ncc:// relay address' }
    }
    return deps.relayLocator.resolve(input)
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

  ipcMain.handle('ncc:set-anchor-required', (_event, value: unknown) => {
    try {
      const config = deps.config.setAnchorRequired(value)
      // Anchoring changes trust policy, not resolution inputs. Drop memoised outcomes
      // but keep public locator cache entries: unanchored ones are rechecked on use.
      for (const resolver of deps.resolvers) resolver.clearCache()
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-prefer-tor', (_event, value: unknown) => {
    try {
      const config = deps.config.setPreferTor(value)
      deps.transport.clear()
      deps.shell.applyTorPreference()
      if (config.preferTor) void deps.tor.ensureReady().catch(() => undefined)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-tor-mode', async (_event, value: unknown) => {
    try {
      const config = deps.config.setTorMode(value)
      await deps.tor.reset()
      deps.transport.clear()
      deps.shell.applyTorPreference()
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-tor-socks', async (_event, value: unknown) => {
    try {
      const normalized = normalizeTorProxy(value)
      const config = deps.config.setTorSocks(normalized)
      await deps.tor.reset()
      deps.transport.clear()
      deps.shell.applyTorPreference()
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-tor-config', async (_event, payload: unknown) => {
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
      deps.shell.applyTorPreference()
      if (config.preferTor) void deps.tor.ensureReady().catch(() => undefined)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-security-config', (_event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid security settings' }
      }
      const { httpsMode, warnInsecure } = payload as {
        httpsMode?: unknown
        warnInsecure?: unknown
      }
      const before = deps.config.get()
      deps.config.setHttpsMode(httpsMode)
      const config = deps.config.setWarnInsecure(warnInsecure)
      if (before.httpsMode !== config.httpsMode || before.warnInsecure !== config.warnInsecure) {
        deps.shell.applySecuritySettings()
      }
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:remove-http-exception', (_event, key: unknown) => {
    if (typeof key !== 'string') return deps.config.get()
    const config = deps.config.removeHttpException(key)
    deps.shell.applySecuritySettings()
    return config
  })

  ipcMain.handle('ncc:clear-http-exceptions', () => {
    const config = deps.config.clearHttpExceptions()
    deps.shell.applySecuritySettings()
    return config
  })

  ipcMain.handle('ncc:tor-status', () => deps.tor.status())
  ipcMain.handle('ncc:tor-test', () => deps.tor.test())
  ipcMain.handle('ncc:tor-restart', async () => {
    await deps.tor.reset()
    deps.transport.clear()
    deps.shell.applyTorPreference()
    return deps.tor.test()
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
    if (!fromChrome(event)) return
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
    if (!fromChrome(event)) return
    if (typeof command !== 'string' || !commandIds.has(command)) return
    deps.shell.runCommand(command as CommandId)
  })

  ipcMain.handle('ncc:set-overlay', (event, payload: unknown) => {
    if (!fromChrome(event)) return
    if (!payload || typeof payload !== 'object') return
    const { reason, active } = payload as { reason?: unknown; active?: unknown }
    if (typeof reason !== 'string' || !overlayReasons.has(reason)) return
    deps.shell.setOverlay(reason, active === true)
  })

  ipcMain.handle('ncc:bookmarks', () => deps.shell.getBookmarks())

  ipcMain.handle('ncc:toggle-bookmark', (event) => {
    if (!fromChrome(event)) return []
    return deps.shell.toggleBookmark()
  })

  ipcMain.handle('ncc:remove-bookmark', (event, url: unknown) => {
    if (!fromChrome(event) || typeof url !== 'string') return deps.shell.getBookmarks()
    return deps.shell.removeBookmark(url)
  })

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

  ipcMain.handle('ncc:window-minimize', (event) => {
    if (fromChrome(event)) deps.shell.minimizeWindow()
  })
  ipcMain.handle('ncc:window-toggle-maximize', (event) => {
    if (fromChrome(event)) deps.shell.toggleMaximizeWindow()
  })
  ipcMain.handle('ncc:window-close', (event) => {
    if (fromChrome(event)) deps.shell.closeWindow()
  })
}

function resetCaches(deps: IpcDeps): void {
  for (const resolver of deps.resolvers) resolver.clearCache()
  deps.cacheStore.clear()
  deps.pins.clear()
  deps.health.clear()
}
