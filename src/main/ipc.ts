import { ipcMain, shell, app } from 'electron'
import { COMMANDS, type CommandId } from '@shared/commands'
import { OVERLAY_REASONS, DEFAULT_PROTECTION } from '@shared/types'
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
import { applyThemeSource } from './appearance'
import type { IdentityManager } from './signer/manager'
import type { PasswordService } from './passwords/service'
import type { PermissionStore } from './signer/permissions'
import { signerOriginFromUrl } from './signer/origin'
import { browserShellFor, browserShells, type BrowserShell } from './shell'
import type { ProtectionService } from './protection'
import type { HostingService } from './hosting/service'
import type { HostingDraft } from '@shared/hosting'
import { discoverReachability } from './hosting/discover'

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
  passwords: PasswordService
  protection: ProtectionService
  hosting: HostingService
}

export function registerIpc(deps: IpcDeps): void {
  const commandIds = new Set<string>(COMMANDS.map((command) => command.id))
  const overlayReasons = new Set<string>(OVERLAY_REASONS)
  const shellFor = (event: Electron.IpcMainInvokeEvent): BrowserShell => browserShellFor(event.sender) ?? deps.shell
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean => browserShellFor(event.sender) !== null

  ipcMain.handle('ncc:navigate', (event, input: unknown) => shellFor(event).navigate(String(input ?? '')))

  ipcMain.handle('ncc:back', (event) => shellFor(event).back())
  ipcMain.handle('ncc:forward', (event) => shellFor(event).forward())
  ipcMain.handle('ncc:reload', (event) => shellFor(event).reload())
  ipcMain.handle('ncc:force-reload', (event) => shellFor(event).forceReload())
  ipcMain.handle('ncc:stop', (event) => shellFor(event).stop())
  ipcMain.handle('ncc:toggle-tor', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).toggleTor()
  })
  ipcMain.handle('ncc:insecure-choice', (event, choice: unknown) => {
    if (!fromChrome(event)) return
    if (choice !== 'cancel' && choice !== 'continue' && choice !== 'always') return
    shellFor(event).insecureChoice(choice)
  })

  ipcMain.handle('ncc:new-tab', (event, input: unknown) =>
    shellFor(event).newTab(typeof input === 'string' ? input : undefined)
  )
  ipcMain.handle('ncc:new-private-tab', (event, input: unknown) => {
    if (!fromChrome(event)) return ''
    return shellFor(event).newPrivateTab(typeof input === 'string' ? input : undefined)
  })
  ipcMain.handle('ncc:new-tor-tab', (event, input: unknown) => {
    if (!fromChrome(event)) return ''
    return shellFor(event).newTorTab(typeof input === 'string' ? input : undefined)
  })
  ipcMain.handle('ncc:close-tab', (event, id: unknown) =>
    shellFor(event).closeTab(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:select-tab', (event, id: unknown) => {
    if (typeof id === 'string') shellFor(event).selectTab(id)
  })
  ipcMain.handle('ncc:move-tab', (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { id, toIndex } = payload as { id?: unknown; toIndex?: unknown }
    if (typeof id !== 'string' || typeof toIndex !== 'number') return
    shellFor(event).moveTab(id, toIndex)
  })
  ipcMain.handle('ncc:detach-tab', (event, payload: unknown) => {
    if (!fromChrome(event) || !payload || typeof payload !== 'object') return
    const { id, screenX, screenY } = payload as { id?: unknown; screenX?: unknown; screenY?: unknown }
    if (typeof id !== 'string' || typeof screenX !== 'number' || typeof screenY !== 'number') return
    shellFor(event).detachTab(id, screenX, screenY)
  })
  ipcMain.handle('ncc:duplicate-tab', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).duplicateTab(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:reload-tab', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).reloadTab(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:toggle-mute', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).toggleMute(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:close-other-tabs', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).closeOtherTabs(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:close-tabs-right', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).closeTabsToRight(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:new-tab-menu', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).showNewTabMenu()
  })

  ipcMain.handle('ncc:tab-menu', (event, id: unknown) => {
    if (!fromChrome(event) || typeof id !== 'string') return
    shellFor(event).showTabMenu(id)
  })

  ipcMain.handle('ncc:tab-history', (event, id: unknown) =>
    shellFor(event).getTabHistory(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:go-history-index', (event, index: unknown) => {
    if (!fromChrome(event) || typeof index !== 'number') return
    shellFor(event).goToHistoryIndex(index)
  })
  ipcMain.handle('ncc:clear-history', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).clearHistory()
  })
  ipcMain.handle('ncc:history-menu', (event, direction: unknown) => {
    if (!fromChrome(event)) return
    if (direction !== 'back' && direction !== 'forward') return
    shellFor(event).showHistoryMenu(direction)
  })

  ipcMain.handle('ncc:get-state', (event) => shellFor(event).getState())
  ipcMain.handle('ncc:get-config', () => deps.config.get())
  ipcMain.handle('ncc:protection-summary', (event, rawUrl: unknown, rawKind: unknown) => {
    const url = typeof rawUrl === 'string' ? rawUrl : ''
    const kind = rawKind === 'private' || rawKind === 'tor' ? rawKind : 'normal'
    let origin = ''
    try { origin = new URL(url).origin } catch { /* not a web origin */ }
    const config = deps.config.get().protection ?? DEFAULT_PROTECTION
    return { level: config.level, blocked: deps.protection.countFor(url), excepted: deps.protection.isExcepted(origin, kind) }
  })

  ipcMain.handle('ncc:omnibox-suggest', (event, input: unknown) => {
    if (!fromChrome(event)) return []
    return shellFor(event).suggest(typeof input === 'string' ? input : '')
  })

  ipcMain.handle('ncc:clear-browsing-history', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).clearBrowsingHistory()
  })

  ipcMain.handle('ncc:set-search-config', (event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid search settings' }
      }
      const { engine, custom, useOnionSearch, nccSearchEnabled } = payload as {
        engine?: unknown
        custom?: unknown
        useOnionSearch?: unknown
        nccSearchEnabled?: unknown
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
      const config = deps.config.setSearchConfig({ engine, custom: template, useOnionSearch, nccSearchEnabled })
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-appearance', (event, payload: unknown) => {
    if (!fromChrome(event)) {
      return { ok: false, error: 'Appearance can only change from the browser chrome' }
    }
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid appearance settings' }
      }
      const before = deps.config.get().appearance
      const config = deps.config.setAppearance(payload)
      if (config.appearance.theme !== before.theme) {
        applyThemeSource(config.appearance.theme)
      }
      for (const browserShell of browserShells()) browserShell.applyAppearance()
      for (const browserShell of browserShells()) browserShell.sendConfig(config)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:hosting-state', () => deps.hosting.state())
  ipcMain.handle('ncc:hosting-create', (event, draft: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    deps.hosting.create(draft as HostingDraft)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-update', (event, payload: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    const { id, draft } = (payload ?? {}) as { id?: unknown; draft?: unknown }
    if (typeof id !== 'string') throw new Error('A service id is required')
    deps.hosting.update(id, draft as HostingDraft)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-remove', (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    if (typeof id !== 'string') throw new Error('A service id is required')
    deps.hosting.remove(id)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-publish', (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    if (typeof id !== 'string') throw new Error('A service id is required')
    return deps.hosting.publish(id)
  })
  ipcMain.handle('ncc:hosting-share', (event, payload: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    const { id, recipient, days, label } = (payload ?? {}) as {
      id?: unknown
      recipient?: unknown
      days?: unknown
      label?: unknown
    }
    if (typeof id !== 'string' || typeof recipient !== 'string') {
      throw new Error('A service id and a recipient npub are required')
    }
    return deps.hosting.share(
      id,
      recipient,
      typeof days === 'number' ? days : 7,
      typeof label === 'string' ? label : undefined
    )
  })
  ipcMain.handle('ncc:hosting-share-many', (event, payload: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    const { id, recipients, days, label } = (payload ?? {}) as {
      id?: unknown
      recipients?: unknown
      days?: unknown
      label?: unknown
    }
    if (typeof id !== 'string' || !Array.isArray(recipients)) {
      throw new Error('A service id and at least one recipient are required')
    }
    const list = recipients.filter((recipient): recipient is string => typeof recipient === 'string')
    return deps.hosting.shareMany(
      id,
      list,
      typeof days === 'number' ? days : 7,
      typeof label === 'string' ? label : undefined
    )
  })

  ipcMain.handle('ncc:hosting-revoke-share', (event, shareId: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    if (typeof shareId !== 'string') throw new Error('A share id is required')
    return deps.hosting.revokeShare(shareId)
  })
  ipcMain.handle('ncc:hosting-forget-received', (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    if (typeof id !== 'string') throw new Error('A share id is required')
    deps.hosting.forgetReceived(id)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-discover-endpoints', (event, seedUrl: unknown) => {
    if (!fromChrome(event)) throw new Error('Services are only available to the browser chrome')
    if (typeof seedUrl !== 'string' || !seedUrl.trim()) {
      throw new Error('Open an http(s) page to discover its endpoint')
    }
    return discoverReachability({ seedUrl: seedUrl.trim() })
  })

  ipcMain.handle('ncc:set-relays', (event, relays: unknown) => {
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

  ipcMain.handle('ncc:resolve-relay-locator', async (event, input: unknown) => {
    if (typeof input !== 'string') {
      return { ok: false, code: 'invalid-address', error: 'Enter an ncc:// relay address' }
    }
    return deps.relayLocator.resolve(input)
  })

  ipcMain.handle('ncc:set-gossip', (event, value: unknown) => {
    try {
      const config = deps.config.setGossip(value)
      resetCaches(deps)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-anchor-required', (event, value: unknown) => {
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

  ipcMain.handle('ncc:set-prefer-tor', (event, value: unknown) => {
    try {
      const config = deps.config.setPreferTor(value)
      deps.transport.clear()
      for (const browserShell of browserShells()) browserShell.applyTorPreference()
      if (config.preferTor) void deps.tor.ensureReady().catch(() => undefined)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-ephemeral-signer', (event, value: unknown) => {
    if (!fromChrome(event)) return { ok: false, error: 'Settings can only change from the browser chrome' }
    try {
      const config = deps.config.setEphemeralSigner(value)
      for (const browserShell of browserShells()) browserShell.window.webContents.send('ncc:config', config)
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-tor-mode', async (event, value: unknown) => {
    try {
      const config = deps.config.setTorMode(value)
      await deps.tor.reset()
      deps.transport.clear()
      for (const browserShell of browserShells()) browserShell.applyTorPreference()
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:set-security-config', (event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid security settings' }
      }
      const { httpsMode, warnInsecure, protection } = payload as {
        httpsMode?: unknown
        warnInsecure?: unknown
        protection?: unknown
      }
      const before = deps.config.get()
      deps.config.setHttpsMode(httpsMode)
      deps.config.setWarnInsecure(warnInsecure)
      const config = deps.config.setProtection(protection)
      if (before.httpsMode !== config.httpsMode || before.warnInsecure !== config.warnInsecure || JSON.stringify(before.protection) !== JSON.stringify(config.protection)) {
        for (const browserShell of browserShells()) browserShell.applySecuritySettings()
      }
      return { ok: true, config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('ncc:remove-http-exception', (event, key: unknown) => {
    if (typeof key !== 'string') return deps.config.get()
    const config = deps.config.removeHttpException(key)
    for (const browserShell of browserShells()) browserShell.applySecuritySettings()
    return config
  })

  ipcMain.handle('ncc:set-protection-exception', (event, rawOrigin: unknown, allowed: unknown, rawKind: unknown) => {
    if (!fromChrome(event) || typeof rawOrigin !== 'string') return deps.config.get()
    try {
      const origin = new URL(rawOrigin).origin
      const kind = rawKind === 'private' || rawKind === 'tor' ? rawKind : 'normal'
      const config = deps.protection.setSiteException(origin, allowed === true, kind)
      for (const browserShell of browserShells()) browserShell.applySecuritySettings()
      return config
    } catch {
      return deps.config.get()
    }
  })

  ipcMain.handle('ncc:clear-http-exceptions', () => {
    const config = deps.config.clearHttpExceptions()
    for (const browserShell of browserShells()) browserShell.applySecuritySettings()
    return config
  })

  ipcMain.handle('ncc:tor-status', () => deps.tor.status())
  ipcMain.handle('ncc:app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch
  }))
  ipcMain.handle('ncc:tor-test', () => deps.tor.test())
  ipcMain.handle('ncc:tor-restart', async () => {
    await deps.tor.reset()
    deps.transport.clear()
    for (const browserShell of browserShells()) browserShell.applyTorPreference()
    return deps.tor.test()
  })

  ipcMain.handle('ncc:identity-status', () => deps.identity.status())
  ipcMain.handle('ncc:identity-list', () => deps.identity.list())
  ipcMain.handle('ncc:identity-select', async (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const status = await deps.identity.select(String(id ?? ''))
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })
  ipcMain.handle('ncc:identity-default', (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    return deps.identity.setDefault(String(id ?? ''))
  })
  ipcMain.handle('ncc:identity-remove-profile', async (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const status = await deps.identity.remove(String(id ?? ''))
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })
  ipcMain.handle('ncc:share-nostr', async (event, rawComment: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const page = shellFor(event).getActivePage()
    if (!page) throw new Error('Open a page first')
    const state = shellFor(event).getState()
    if (state.tabKind !== 'normal') throw new Error('Normal tabs only')
    const provider = deps.identity.provider()
    if (!provider) throw new Error('Sign in first')
    const relays = deps.config.get().relays.map((entry) => entry.url).filter(Boolean)
    if (!relays.length) throw new Error('No relays are configured')
    const comment = typeof rawComment === 'string' ? rawComment.slice(0, 2000) : ''
    const content = `${page.title && page.title !== 'New tab' ? `${page.title}\n` : ''}${page.url}${comment ? `\n\n${comment}` : ''}`
    const eventTemplate = { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }
    const signed = await provider.signEvent(eventTemplate)
    const results = await Promise.allSettled(relays.map((url) => deps.relayPool.publish(url, signed)))
    return { accepted: results.filter((result) => result.status === 'fulfilled').length, relays: relays.length, error: results.every((result) => result.status === 'rejected') ? String((results[0] as PromiseRejectedResult)?.reason ?? '') : undefined }
  })

  ipcMain.handle('ncc:identity-import', async (event, secret: unknown) => {
    const status = await deps.identity.importLocal(String(secret ?? ''))
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-generate', async () => {
    const status = await deps.identity.generateLocal()
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-remove', async () => {
    const status = await deps.identity.removeLocal()
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-connect-bunker', async (event, url: unknown) => {
    const status = await deps.identity.connectRemote(String(url ?? ''))
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-disconnect', async () => {
    const status = await deps.identity.disconnectRemote()
    deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:signer-permissions', () => deps.permissions.list())

  ipcMain.handle('ncc:signer-pending', (event) => (fromChrome(event) ? deps.approvals.list() : []))

  ipcMain.handle('ncc:signer-origin', (event, raw: unknown) => {
    if (!fromChrome(event)) return null
    const resolved = signerOriginFromUrl(String(raw ?? ''))
    if (!resolved) return null
    return { ...resolved, trusted: deps.permissions.isTrusted(resolved.origin) }
  })

  ipcMain.handle('ncc:signer-trust', (event, payload: unknown) => {
    if (!fromChrome(event)) return null
    if (!payload || typeof payload !== 'object') return null
    const { url, trusted } = payload as { url?: unknown; trusted?: unknown }
    const resolved = signerOriginFromUrl(String(url ?? ''))
    if (!resolved) return null
    if (trusted === true) deps.permissions.trust(resolved.origin, resolved.label)
    else deps.permissions.revoke(resolved.origin)
    return { ...resolved, trusted: deps.permissions.isTrusted(resolved.origin) }
  })

  ipcMain.handle('ncc:revoke-permission', (event, origin: unknown) => {
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
    shellFor(event).runCommand(command as CommandId)
  })

  ipcMain.handle('ncc:set-overlay', (event, payload: unknown) => {
    if (!fromChrome(event)) return
    if (!payload || typeof payload !== 'object') return
    const { reason, active } = payload as { reason?: unknown; active?: unknown }
    if (typeof reason !== 'string' || !overlayReasons.has(reason)) return
    shellFor(event).setOverlay(reason, active === true)
  })

  ipcMain.handle('ncc:bookmarks', (event) => shellFor(event).getBookmarks())

  ipcMain.handle('ncc:toggle-bookmark', (event) => {
    if (!fromChrome(event)) return []
    return shellFor(event).toggleBookmark()
  })

  ipcMain.handle('ncc:remove-bookmark', (event, url: unknown) => {
    if (!fromChrome(event) || typeof url !== 'string') return shellFor(event).getBookmarks()
    return shellFor(event).removeBookmark(url)
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
    if (fromChrome(event)) shellFor(event).minimizeWindow()
  })
  ipcMain.handle('ncc:window-toggle-maximize', (event) => {
    if (fromChrome(event)) shellFor(event).toggleMaximizeWindow()
  })
  ipcMain.handle('ncc:window-close', (event) => {
    if (fromChrome(event)) shellFor(event).closeWindow()
  })
}

function resetCaches(deps: IpcDeps): void {
  for (const resolver of deps.resolvers) resolver.clearCache()
  deps.cacheStore.clear()
  deps.pins.clear()
  deps.health.clear()
}
