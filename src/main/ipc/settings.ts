import { app, ipcMain } from 'electron'
import { DEFAULT_PROTECTION } from '@shared/types'
import { isSearchEngineId, searxTemplate, validateSearchTemplate } from '@shared/search'
import { applyThemeSource } from '../appearance'
import type { ConfigStore } from '../config'
import type { TransportPolicy } from '../ncc/transport'
import type { ProtectionService } from '../protection'
import type { RelayLocatorService } from '../relay/locator'
import type { RelayPool } from '../relay/pool'
import type { RelayPinStore } from '../relay/socket'
import { browserShells } from '../shell'
import type { IdentityManager } from '../signer/manager'
import type { TorManager } from '../tor/manager'
import { isChromeSender, resetCaches, type CacheResettingDeps } from './shared'

export interface SettingsIpcDeps extends CacheResettingDeps {
  config: ConfigStore
  protection: ProtectionService
  identity: IdentityManager
  relayPins: RelayPinStore
  relayPool: RelayPool
  relayLocator: RelayLocatorService
  transport: TransportPolicy
  tor: TorManager
}

const failure = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error)
})

/**
 * Browser-wide configuration: relays and resolution policy, search, appearance,
 * HTTPS/protection and the app-version rows. Every handler returns the new config so
 * the chrome can re-render from one response.
 */
export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean => isChromeSender(event)

  ipcMain.handle('ncc:get-config', () => deps.config.get())

  ipcMain.handle('ncc:protection-summary', (event, rawUrl: unknown, rawKind: unknown) => {
    const url = typeof rawUrl === 'string' ? rawUrl : ''
    const kind = rawKind === 'private' || rawKind === 'tor' ? rawKind : 'normal'
    let origin = ''
    try { origin = new URL(url).origin } catch { /* not a web origin */ }
    const config = deps.config.get().protection ?? DEFAULT_PROTECTION
    return { level: config.level, blocked: deps.protection.countFor(url), excepted: deps.protection.isExcepted(origin, kind) }
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
      return failure(error)
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
      return failure(error)
    }
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
      return failure(error)
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
      return failure(error)
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
      return failure(error)
    }
  })

  ipcMain.handle('ncc:set-external-address-checks', (event, value: unknown) => {
    try {
      return { ok: true, config: deps.config.setExternalAddressChecks(value) }
    } catch (error) {
      return failure(error)
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
      return failure(error)
    }
  })

  ipcMain.handle('ncc:set-ephemeral-signer', (event, value: unknown) => {
    if (!fromChrome(event)) return { ok: false, error: 'Settings can only change from the browser chrome' }
    try {
      const config = deps.config.setEphemeralSigner(value)
      for (const browserShell of browserShells()) browserShell.window.webContents.send('ncc:config', config)
      return { ok: true, config }
    } catch (error) {
      return failure(error)
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
      return failure(error)
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

  ipcMain.handle('ncc:app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch
  }))
}
