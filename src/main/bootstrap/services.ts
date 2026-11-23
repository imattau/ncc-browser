import { app, Menu, nativeTheme, safeStorage } from 'electron'
import { join } from 'node:path'
import { ApprovalBroker } from '../approval'
import { AutomationController } from '../automation/controller'
import { createElectronHost } from '../automation/electron-host'
import { registerAutomationIpc } from '../automation/ipc'
import { AutomationSettings } from '../automation/settings'
import { registerContactsIpc } from '../contacts/ipc'
import { registerExtensionIpc } from '../extensions/ipc'
import { ExtensionService } from '../extensions/runtime'
import { registerIpc } from '../ipc'
import { registerNsitePublishIpc } from '../nsite-publish/ipc'
import { PasswordCache } from '../passwords/cache'
import { electronClipboard, electronFileDialogs, registerPasswordIpc } from '../passwords/ipc'
import { PasswordService } from '../passwords/service'
import { PaymentCardCache } from '../payment-cards/cache'
import { createPaymentCardAuth } from '../payment-cards/auth'
import { registerPaymentCardIpc } from '../payment-cards/ipc'
import { NostrPaymentCardAuth } from '../payment-cards/nostr-auth'
import { PaymentCardService } from '../payment-cards/service'
import { RelaySync } from '../relay/sync'
import { EXTENSION_PARTITION } from '../sessions'
import { registerNip07 } from '../signer/ipc'
import { Nip07Service } from '../signer/service'
import { registerSiteDataIpc } from '../site-data-ipc'
import { SiteDataService } from '../site-data'
import { registerSyncIpc } from '../sync/ipc'
import { SyncPrefsStore } from '../sync/prefs'
import { SyncService } from '../sync/service'
import { registerNwcIpc } from '../wallet/nwc-ipc'
import { NwcService } from '../wallet/nwc-service'
import { registerWalletIpc } from '../wallet/ipc'
import { WalletService } from '../wallet/service'
import type { BrowserStack } from './browser'
import type { Foundation } from './foundation'
import { findStartupAddress } from './options'
import type { Runtime } from './runtime'
import type { ShellStack } from './shell'

/**
 * Everything that needs the chrome window: approvals, passwords, payment cards, the
 * wallet, sync, the signer, extensions, site data and automation. Also registers the
 * IPC surface and the startup timers.
 */
export function createServices(
  runtime: Runtime,
  foundation: Foundation,
  browser: BrowserStack,
  shellStack: ShellStack
): void {
  const { config, identity, permissions, sitePermissions, relayPool } = foundation
  const shell = shellStack.shell
  const userData = app.getPath('userData')

  const approvals = new ApprovalBroker({
    send: (channel, payload) => {
      if (!runtime.shell || runtime.shell.window.isDestroyed()) return false
      runtime.shell.window.webContents.send(channel, payload)
      return true
    },
    setOverlay: (visible) => {
      const target = runtime.shell
      if (!target) return
      target.setOverlay('approval', visible)
      if (visible && !target.window.isDestroyed()) {
        // Agent approvals can originate while the browser is behind another window.
        // Surface the request so the user can actually answer the permission prompt.
        target.window.show()
        target.window.focus()
      }
    },
    timeoutMs: 120_000
  })

  const passwordService = new PasswordService({
    config,
    identity,
    relays: relayPool,
    cache: new PasswordCache(join(userData, 'passwords.json')),
    host: shell,
    clipboard: electronClipboard(),
    dialogs: electronFileDialogs(shell),
    onLock: () => runtime.paymentCards?.lock()
  })
  runtime.passwords = passwordService
  const paymentCards = new PaymentCardService({
    identity,
    relays: relayPool,
    host: shell,
    cache: new PaymentCardCache(join(userData, 'payment-cards.json')),
    auth: createPaymentCardAuth(shell.window),
    nostrAuth: new NostrPaymentCardAuth(identity, approvals),
    relaysFor: (pubkey) => passwordService.relaysFor(pubkey),
    config: {
      enabled: () => config.get().passwords.fillPaymentCards,
      offerSave: () => config.get().passwords.offerPaymentCardSave,
      saveSecurityCodes: () => config.get().passwords.savePaymentCardSecurityCodes,
      allowNostrAuth: () => config.get().passwords.allowNostrPaymentCardAuth,
      defaultNostrAuth: () => config.get().passwords.defaultNostrPaymentCardAuth,
      setDefaultNostrAuth: (enabled) => {
        config.setPasswordConfig({
          allowNostrPaymentCardAuth: true,
          defaultNostrPaymentCardAuth: enabled
        })
      }
    }
  })
  runtime.paymentCards = paymentCards
  registerPasswordIpc(passwordService, {
    shell,
    afterUnlock: () => paymentCards.unlock(),
    afterConfigChange: async (input) => {
      if (typeof input.savePaymentCardSecurityCodes === 'boolean') {
        await paymentCards.setSecurityCodeSaving(input.savePaymentCardSecurityCodes)
      }
    }
  })
  registerPaymentCardIpc(paymentCards, shell)

  const walletService = new WalletService(
    join(userData, 'wallet-prefs.json'),
    foundation.localIdentity,
    identity,
    () => (config.get().preferTor ? runtime.torManager?.status().proxy ?? null : null),
    undefined,
    join(userData, 'monero-wallet.json'),
    () => {
      const pubkey = identity.status().hexPubkey
      return pubkey
        ? passwordService.relaysFor(pubkey)
        : config.get().relays.map((relay) => relay.url).filter(Boolean)
    },
    relayPool
  )
  runtime.walletService = walletService
  registerWalletIpc(walletService, shell)

  const nwcService = new NwcService(
    join(userData, 'nwc-connection.json'),
    relayPool,
    (value) => {
      if (!foundation.encryptionAvailable) {
        throw new Error('Secure storage is unavailable on this system')
      }
      return safeStorage.encryptString(value).toString('base64')
    },
    (value) => {
      if (!foundation.encryptionAvailable) {
        throw new Error('Secure storage is unavailable on this system')
      }
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
  )
  runtime.nwcService = nwcService
  registerNwcIpc(nwcService, shell, browser.content)

  shell.window.webContents.on('did-finish-load', () => passwordService.clearOverlays())
  shell.window.on('focus', () => void passwordService.onWindowFocus())

  const syncService = new SyncService({
    prefs: new SyncPrefsStore(join(userData, 'sync.json')),
    identity,
    relays: relayPool,
    resolveRelays: (pubkey) => passwordService.relaysFor(pubkey),
    bookmarks: shellStack.bookmarks,
    history: shellStack.history,
    tabs: () => shell.syncTabs(),
    platform:
      process.platform === 'darwin'
        ? 'mac'
        : process.platform === 'win32'
          ? 'windows'
          : 'linux',
    notify: (status) => {
      if (shell.window.isDestroyed()) return
      shell.sendToChrome('ncc:sync-status', status)
      shell.sendToChrome('ncc:bookmarks', shellStack.bookmarks.list())
    }
  })
  shell.onTabsChanged = () => syncService.tabsChanged()
  registerSyncIpc(syncService, { shell, openTab: (url) => shell.newTab(url) })
  shell.window.on('focus', () => syncService.onWindowFocus())
  syncService.start()

  const nip07Service = new Nip07Service({
    identity,
    permissions,
    approvals,
    getRelays: () => config.getRelays(),
    autoApprove: process.env.NCC_SIGNER_AUTO_APPROVE === '1',
    useEphemeralSigner: () => config.get().ephemeralSigner
  })
  runtime.nip07Service = nip07Service
  registerNip07(
    nip07Service,
    [
      { session: browser.content.normal, kind: 'normal' },
      { session: browser.content.private, kind: 'private' },
      { session: browser.content.tor, kind: 'tor' }
    ],
    () => runtime.automation
  )

  const extensionService = new ExtensionService({
    registry: foundation.extensionRegistry,
    storage: foundation.extensionStorage,
    host: shell,
    nip07: () => runtime.nip07Service,
    preloadPath: join(__dirname, '../preload/content.js'),
    partition: EXTENSION_PARTITION
  })
  runtime.extensions = extensionService
  registerExtensionIpc(extensionService, { shell })
  extensionService.start()

  const siteDataService = new SiteDataService({
    host: shell,
    config,
    permissions,
    sitePermissions,
    sessions: {
      normal: browser.content.normal,
      private: browser.content.private,
      tor: browser.content.tor
    },
    extensionSession: browser.content.extensions,
    locators: {
      count: () => foundation.cacheStore.size(),
      clear: () => {
        for (const value of foundation.resolvers) value.clearCache()
        foundation.cacheStore.clear()
      },
      invalidate: (kind, pubkey, service) =>
        browser.invalidateSite(`ncc://${pubkey}${service ? `/${service}` : ''}`, kind)
    }
  })
  registerSiteDataIpc(siteDataService, { shell })

  shell.window.on('closed', () => approvals.cancelAll())

  // Theme source changes (and OS theme changes in "system" mode) update the native
  // window background; the chrome follows through `prefers-color-scheme`.
  nativeTheme.on('updated', () => runtime.shell?.applyAppearance())

  // Re-resolve identity-backed relays before their locators expire. A rotation
  // updates the config, moves the TLS pin and drops the old pool connection.
  const relaySync = new RelaySync({
    entries: () => config.getRelayEntries(),
    refresh: (entry) => foundation.relayLocator.refresh(entry),
    apply: (previousUrl, next) => {
      const updated = config.replaceRelayEntry(previousUrl, next)
      foundation.relayPins.clearUrl(previousUrl)
      foundation.relayPins.setForEntry(next)
      if (next.url !== previousUrl) relayPool.closeUrls([previousUrl])
      for (const value of foundation.resolvers) value.clearCache()
      runtime.shell?.sendConfig(updated)
    },
    markStale: (url, stale) => {
      runtime.shell?.sendConfig(config.markRelayStale(url, stale))
    },
    refreshExtra: async () => {
      await identity.refreshBunkerRelays((entry) => foundation.relayLocator.refresh(entry))
    },
    onError: (error) => console.warn('[relay-sync]', error)
  })
  runtime.relaySync = relaySync

  // No in-window menu bar: shortcuts are handled in main, the rest lives in the
  // hamburger menu. macOS still needs a system application menu.
  if (process.platform === 'darwin') {
    // Keep the system app/edit menus for macOS conventions, but no windowMenu: its
    // Cmd+W close accelerator would fight the tab-level shortcut.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    )
  } else {
    Menu.setApplicationMenu(null)
  }

  registerIpc({
    shell,
    config,
    protection: foundation.protection,
    resolvers: foundation.resolvers,
    pins: foundation.pins,
    relayPins: foundation.relayPins,
    relayLocator: foundation.relayLocator,
    relayPool,
    cacheStore: foundation.cacheStore,
    health: foundation.health,
    transport: browser.transport,
    tor: browser.tor,
    identity,
    permissions,
    approvals,
    downloads: browser.downloads,
    passwords: passwordService,
    hosting: foundation.hosting,
    onion: runtime.onionManager!,
    publicAddress: foundation.publicAddress,
    portMappings: runtime.portMappings!,
    network: foundation.networkWatch
  })

  registerNsitePublishIpc(foundation.nsitePublish, shell)
  registerContactsIpc(foundation.contacts, shell)

  const hostingRenewal = setInterval(() => void foundation.hosting.renewDue(), 6 * 3600_000)
  hostingRenewal.unref()
  const hostingStartup = setTimeout(() => void foundation.hosting.renewDue(), 5_000)
  hostingStartup.unref()

  // Optional launch address: `ncc-browser ncc://npub1…/service`. A fresh launch uses
  // the restored blank tab; a real restored session gets the address in a new tab.
  const startupAddress = findStartupAddress()
  if (startupAddress) {
    const hasRestoredPages = shellStack.initialSession?.tabs.some((tab) => tab.url) ?? false
    shell.window.webContents.once('did-finish-load', () => {
      if (hasRestoredPages) shell.newTab(startupAddress)
      else void shell.navigate(startupAddress)
    })
  }

  // Agent control: a loopback MCP server that lets a client such as Claude Code drive
  // ordinary tabs. Off until enabled in Settings (or NCC_AUTOMATION=1); docs/automation.md.
  const automation = new AutomationController({
    settings: new AutomationSettings(join(userData, 'automation-settings.json')),
    host: createElectronHost(shell),
    approvals,
    passwords: passwordService,
    relays: relayPool.query,
    configRelays: () => config.getRelays(),
    version: app.getVersion(),
    infoFile: join(userData, 'automation.json'),
    forced: process.env.NCC_AUTOMATION === '1',
    autoApprove: process.env.NCC_AUTOMATION_AUTO_APPROVE === '1',
    ...(Number(process.env.NCC_AUTOMATION_PORT) > 0
      ? { port: Number(process.env.NCC_AUTOMATION_PORT) }
      : {}),
    onChange: (state) => runtime.shell?.sendToChrome('ncc:automation-state', state)
  })
  runtime.automation = automation
  registerAutomationIpc(automation, { shell })
  void automation.sync().catch((error) => console.warn('[automation] could not start:', error))
  app.on('before-quit', () => automation.shutdown())

  shell.loadChrome()
  relaySync.start()
  if (runtime.pendingExternalUrl) {
    void shell.navigate(runtime.pendingExternalUrl)
    runtime.pendingExternalUrl = null
  }
}
