import { app, Menu, nativeTheme, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { parseNccAddress } from '@shared/ncc-url'
import { parseNsiteAddress } from '@shared/nsite-url'
import type { TabKind } from '@shared/types'
import { ApprovalBroker } from './approval'
import { createElectronHost } from './automation/electron-host'
import { AutomationController } from './automation/controller'
import { registerAutomationIpc } from './automation/ipc'
import { AutomationSettings } from './automation/settings'
import { applyThemeSource } from './appearance'
import { BookmarkStore } from './bookmarks'
import { HistoryStore } from './history'
import { OmniboxService } from './omnibox'
import { LocatorCacheStore } from './cache-store'
import { ConfigStore } from './config'
import { DownloadManager } from './downloads'
import { registerIpc } from './ipc'
import { registerExtensionIpc } from './extensions/ipc'
import { SiteDataService } from './site-data'
import { registerSiteDataIpc } from './site-data-ipc'
import { installExtensionProtocol } from './extensions/protocol'
import { ExtensionRegistry } from './extensions/registry'
import { ExtensionService } from './extensions/runtime'
import { ExtensionStorage } from './extensions/storage'
import { PasswordCache } from './passwords/cache'
import { electronClipboard, electronFileDialogs, registerPasswordIpc } from './passwords/ipc'
import { PasswordService } from './passwords/service'
import { PaymentCardCache } from './payment-cards/cache'
import { createPaymentCardAuth } from './payment-cards/auth'
import { NostrPaymentCardAuth } from './payment-cards/nostr-auth'
import { PaymentCardService } from './payment-cards/service'
import { registerPaymentCardIpc } from './payment-cards/ipc'
import { WalletService } from './wallet/service'
import { registerWalletIpc } from './wallet/ipc'
import { NwcService } from './wallet/nwc-service'
import { registerNwcIpc } from './wallet/nwc-ipc'
import { SyncPrefsStore } from './sync/prefs'
import { SyncService } from './sync/service'
import { registerSyncIpc } from './sync/ipc'
import { EndpointHealth } from './ncc/health'
import { closeSharedPool, NccResolver, signerFromSecret, toHexPubkey, type LocatorSigner } from './ncc/resolver'
import { NsiteBlobs } from './nsite/blob'
import { NsiteResolver } from './nsite/resolver'
import { installNsiteProtocol } from './nsite/protocol'
import { installNccSearchProtocol } from './nccsearch/protocol'
import { installSitePublisherProtocol } from './site-publisher/protocol'
import { installCertificatePinning, PinStore } from './pins'
import { installNccProtocol, type ProtocolActivity } from './protocol'
import { registerPrivilegedSchemes } from './schemes'
import { RelayLocatorService } from './relay/locator'
import { RelayPool } from './relay/pool'
import { RelayPinStore } from './relay/socket'
import { RelaySync } from './relay/sync'
import { BrowserShell, browserShells, type ShellDeps } from './shell'
import { SessionStore } from './session-store'
import type { SavedSession } from './session-store'
import {
  clearContentSession,
  createContentSessions,
  EXTENSION_PARTITION,
  partitionFor,
  type ContentSessions
} from './sessions'
import { TransportPolicy } from './ncc/transport'
import { HttpPolicy } from './security'
import { ProtectionService } from './protection'
import { HostingStore } from './hosting/store'
import { HostingService } from './hosting/service'
import { RelayHostingPublisher } from './hosting/relays'
import { ContactsStore } from './contacts/store'
import { ContactsService } from './contacts/service'
import { registerContactsIpc } from './contacts/ipc'
import { NsiteStore } from './nsite-publish/store'
import { NsitePublishService, RelayNsiteNetwork } from './nsite-publish/service'
import { registerNsitePublishIpc } from './nsite-publish/ipc'
import {
  installShellCameraPermission,
  installSitePermissionPrompts,
  SitePermissionStore
} from './site-permissions'
import { TorGuard } from './tor/guard'
import { TorManager } from './tor/manager'
import { TorControl } from './tor/control'
import { OnionManager, verifyOnionThroughSocks } from './tor/onion'
import { TorRelayPool } from './tor/relay'
import { TorSessionProxy } from './tor/session'
import { createBunkerRelay } from './signer/bunker-relay'
import { IdentityStore } from './signer/identity'
import { registerNip07 } from './signer/ipc'
import { IdentityManager } from './signer/manager'
import { PermissionStore } from './signer/permissions'
import { Nip07Service } from './signer/service'
import { Nip46SessionStore } from './signer/session'

// Custom schemes must be registered before the app is ready, in a single call.
registerPrivilegedSchemes()

app.setName('Nostr Navigator')
// Keep the profile created by earlier NCC Browser builds across the rename.
app.setPath('userData', join(app.getPath('appData'), 'NCC Browser'))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let shell: BrowserShell | null = null
let createFallbackShell: (() => BrowserShell) | null = null
let contentSessions: ContentSessions | null = null
let torManager: TorManager | null = null
let onionManager: OnionManager | null = null
let torRelays: TorRelayPool | null = null
let relaySync: RelaySync | null = null
let passwords: PasswordService | null = null
let paymentCards: PaymentCardService | null = null
let walletService: WalletService | null = null
let nwcService: NwcService | null = null
let extensions: ExtensionService | null = null
let pendingExternalUrl: string | null = null

// macOS can deliver a browser URL before the app is ready, so subscribe before
// creating the window and hold it until the shell can navigate.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!/^(https?):\/\//i.test(url)) return
  const target = browserShells()[0] ?? (shell && !shell.window.isDestroyed() ? shell : null)
  if (target) void target.navigate(url)
  else pendingExternalUrl = url
})

app.whenReady().then(async () => {
  // Register as an available handler so the operating system can offer Nostr
  // Navigator in its default-browser chooser. The user still selects the default.
  for (const scheme of ['http', 'https']) app.setAsDefaultProtocolClient(scheme)
  const config = new ConfigStore()
  const protection = new ProtectionService(config)
  // Resolve light/dark before any window exists so the first paint is correct.
  applyThemeSource(config.get().appearance.theme)
  const pins = new PinStore()
  const relayPins = new RelayPinStore()
  const health = new EndpointHealth()
  const cacheStore = new LocatorCacheStore(join(app.getPath('userData'), 'locator-cache.json'))

  const encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable()
  const identityCodec = {
    available: encryptionAvailable,
    encrypt: async (plaintext: string): Promise<string> => {
      const encrypted = await safeStorage.encryptStringAsync(plaintext)
      return encrypted.toString('base64')
    },
    decrypt: async (ciphertext: string): Promise<string> => {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))
      return decrypted.result
    }
  }

  const localIdentity = await IdentityStore.open({
    filePath: join(app.getPath('userData'), 'identity.json'),
    codec: identityCodec
  })
  if (process.env.NCC_IDENTITY_NSEC) {
    try {
      localIdentity.setFromEnv(process.env.NCC_IDENTITY_NSEC)
      console.warn('[signer] using NCC_IDENTITY_NSEC (development only)')
    } catch (error) {
      console.warn('[signer] ignoring NCC_IDENTITY_NSEC:', error instanceof Error ? error.message : error)
    }
  }

  const sessions = new Nip46SessionStore(
    join(app.getPath('userData'), 'nip46-session.json'),
    identityCodec
  )

  const permissions = new PermissionStore(
    join(app.getPath('userData'), 'signer-permissions.json')
  )
  const sitePermissions = new SitePermissionStore(
    join(app.getPath('userData'), 'site-permissions.json')
  )
  const envLocatorSigner = locatorSignerFromEnv()

  // Relay entries resolved from NCC-05 locators are pinned by `host:port`; restore
  // the pins from the saved config before anything can connect.
  relayPins.setFromEntries(config.getRelayEntries())

  const relayPool = new RelayPool({
    pins: relayPins,
    proxy: () => torManager?.status().proxy ?? null
  })

  // A persisted locator is only reused without a relay query while it is this young.
  // The e2e suite sets it low to exercise rotation without waiting a minute.
  const revalidateSeconds = Number(process.env.NCC_REVALIDATE_SECONDS)
  const resolverOptions = {
    relays: () => config.getRelays(),
    gossip: () => config.get().gossip,
    anchorRequired: () => config.get().anchorRequired,
    getSigner: () => identity.locatorSigner() ?? envLocatorSigner,
    ...(Number.isFinite(revalidateSeconds) && revalidateSeconds > 0
      ? { revalidateSeconds }
      : {})
  }
  const torRelayPool = (torRelays = new TorRelayPool(relayPins))
  const resolver = new NccResolver({
    ...resolverOptions,
    cacheStore,
    query: relayPool.query
  })
  const privateResolver = new NccResolver({ ...resolverOptions, query: relayPool.query })
  const torResolver = new NccResolver({ ...resolverOptions, query: torRelayPool.query })
  const resolvers = [resolver, privateResolver, torResolver]

  const nsiteRelays = () => config.get().relays.map((entry) => entry.url).filter(Boolean)
  const nsiteResolver = new NsiteResolver({ query: relayPool.query, relays: nsiteRelays })
  const privateNsiteResolver = new NsiteResolver({ query: relayPool.query, relays: nsiteRelays })
  const torNsiteResolver = new NsiteResolver({ query: torRelayPool.query, relays: nsiteRelays })
  const nsiteResolvers: Record<TabKind, NsiteResolver> = {
    normal: nsiteResolver,
    private: privateNsiteResolver,
    tor: torNsiteResolver
  }
  const blobDirectory = join(app.getPath('userData'), 'nsite-blobs')
  const nsiteBlobs: Record<TabKind, NsiteBlobs> = {
    normal: new NsiteBlobs({ fetch: (url, init) => content.normal.fetch(url, init), directory: blobDirectory }),
    private: new NsiteBlobs({ fetch: (url, init) => content.private.fetch(url, init), directory: null }),
    tor: new NsiteBlobs({ fetch: (url, init) => content.tor.fetch(url, init), directory: null })
  }

  const relayLocator = new RelayLocatorService({
    resolver,
    entries: () => config.getRelayEntries(),
    torReady: () => torManager?.status().ready ?? false
  })

  const identity = await IdentityManager.create({
    local: localIdentity,
    sessions,
    encryptionAvailable,
    profilesPath: join(app.getPath('userData'), 'identity-profiles.json'),
    localFactory: (id) => IdentityStore.open({
      filePath: join(app.getPath('userData'), 'identity-profiles', `local-${id}.json`),
      codec: identityCodec
    }),
    sessionFactory: (id) => new Nip46SessionStore(
      join(app.getPath('userData'), 'identity-profiles', `nip46-${id}.json`),
      identityCodec
    ),
    timeoutMs: Number(process.env.NCC_NIP46_TIMEOUT_MS) || 60_000,
    resolveRelayLocator: async (input) => {
      const outcome = await relayLocator.resolve(input)
      return outcome.ok ? outcome.entry : null
    },
    onRelayEntriesChanged: (entries) => {
      relayPins.setFromEntries([...config.getRelayEntries(), ...entries])
    },
    bunkerRelay: (urls) => createBunkerRelay({ urls, pool: relayPool })
  })

  const hosting = new HostingService({
    store: new HostingStore(join(app.getPath('userData'), 'services.json')),
    identity: {
      provider: () => identity.provider(),
      status: () => identity.status()
    },
    publisher: new RelayHostingPublisher(relayPool, config),
    anchorRequired: () => config.get().anchorRequired,
    onions: () => onionManager?.statuses() ?? [],
    onChange: (state) => {
      if (shell && !shell.window.isDestroyed()) shell.sendToChrome('ncc:hosting-changed', state)
    }
  })

  const contacts = new ContactsService({
    store: new ContactsStore(join(app.getPath('userData'), 'contacts.json')),
    relays: relayPool,
    config,
    owner: () => identity.status().hexPubkey ?? null,
    onChange: (state) => {
      if (shell && !shell.window.isDestroyed()) shell.sendToChrome('ncc:contacts-changed', state)
    }
  })

  const nsitePublish = new NsitePublishService({
    store: new NsiteStore(join(app.getPath('userData'), 'nsite-sites.json')),
    identity: {
      provider: () => identity.provider(),
      status: () => identity.status()
    },
    network: new RelayNsiteNetwork(relayPool, config),
    onChange: (state) => {
      if (shell && !shell.window.isDestroyed()) shell.sendToChrome('ncc:nsite-changed', state)
    }
  })

  const content = createContentSessions()
  contentSessions = content
  for (const [kind, value] of [['normal', content.normal], ['private', content.private], ['tor', content.tor]] as const) {
    installCertificatePinning(value, pins)
    protection.installCookiePolicy(value, kind)
  }
  const nccSearchAssets = app.isPackaged
    ? join(process.resourcesPath, 'nccsearch')
    : join(app.getAppPath(), 'resources', 'nccsearch')
  installNccSearchProtocol(
    [content.normal, content.private, content.tor],
    nccSearchAssets,
    () => ({
      relays: config.getRelays(),
      pubkey: identity.list().activeId
    })
  )
  const sitePublisherAssets = app.isPackaged
    ? join(process.resourcesPath, 'site-publisher')
    : join(app.getAppPath(), 'resources', 'site-publisher')
  // Normal tab only: publishing needs the durable identity, not a private/Tor session.
  installSitePublisherProtocol(content.normal, sitePublisherAssets)

  const torGuard = new TorGuard()
  torGuard.install(content.normal, (details) => protection.shouldBlock(details, 'normal'))
  torGuard.install(content.private, (details) => protection.shouldBlock(details, 'private'))
  torGuard.install(content.tor, (details) => protection.shouldBlock(details, 'tor'))

  const transport = new TransportPolicy(() => config.get().preferTor)
  const torSessionProxy = new TorSessionProxy([content.normal, content.private], [content.tor])
  try {
    await torSessionProxy.start()
  } catch (error) {
    console.warn('[tor] could not start the PAC server:', error)
  }
  torManager = new TorManager({
    mode: () => config.get().torMode,
    socks: () => config.get().torSocks,
    envSocks: process.env.NCC_TOR_SOCKS ?? null,
    binaryPath: torBinaryPath,
    dataDir: join(app.getPath('userData'), 'tor'),
    ...(Number(process.env.NCC_TOR_BOOTSTRAP_TIMEOUT_MS) > 0
      ? { bootstrapTimeoutMs: Number(process.env.NCC_TOR_BOOTSTRAP_TIMEOUT_MS) }
      : {}),
    onProxyChange: (proxy) => {
      torRelayPool.setProxy(proxy)
      // Rebuild the shared pool so new connections use the new SOCKS agent.
      relayPool.refresh()
      return torSessionProxy.apply(proxy)
    },
    ...(process.env.NCC_TOR_DEBUG === '1'
      ? { log: (line: string) => console.log('[tor]', line) }
      : {})
  })
  const tor = torManager
  onionManager = new OnionManager({
    filePath: join(app.getPath('userData'), 'tor-services.json'),
    tor: {
      ensureReady: () => tor.ensureReady(),
      controlEndpoint: () => tor.controlEndpoint(),
      proxy: () => tor.status().proxy
    },
    createControl: (endpoint) => new TorControl(endpoint),
    verify: verifyOnionThroughSocks,
    onChange: () => {
      if (shell && !shell.window.isDestroyed()) {
        shell.sendToChrome('ncc:hosting-changed', hosting.state())
      }
    },
    ...(process.env.NCC_TOR_DEBUG === '1'
      ? { log: (line: string) => console.log('[onion]', line) }
      : {})
  })
  tor.setReadyHook(() => {
    void onionManager?.restoreAll().catch((error) => {
      console.warn('[onion] could not restore services:', error)
    })
  })
  // A published onion must exist for the locator to work; start Tor for it in the
  // background rather than waiting for an unrelated Tor use.
  if (onionManager.statuses().length > 0) {
    setTimeout(() => {
      void onionManager?.restoreAll().catch((error) => {
        console.warn('[onion] could not restore services:', error)
      })
    }, 5_000)
  }

  const httpPolicies: Record<TabKind, HttpPolicy> = {
    normal: new HttpPolicy('normal', config),
    private: new HttpPolicy('private', config),
    tor: new HttpPolicy('tor', config)
  }

  const activeServices: Record<TabKind, Map<string, string>> = {
    normal: new Map(),
    private: new Map(),
    tor: new Map()
  }
  const endpointOwners: Record<TabKind, Map<string, { pubkey: string; service: string }>> = {
    normal: new Map(),
    private: new Map(),
    tor: new Map()
  }

  const downloadDirectory = process.env.NCC_DOWNLOAD_DIR?.trim()
  const downloads = new DownloadManager({
    ...(downloadDirectory ? { directory: downloadDirectory } : {}),
    notify: (notice) => shell?.notifyDownload(notice)
  })
  downloads.install(content.normal, 'normal')
  downloads.install(content.private, 'private')
  downloads.install(content.tor, 'tor')

  let nip07Service: Nip07Service | null = null
  const extensionDir = join(app.getPath('userData'), 'extensions')
  const extensionRegistry = new ExtensionRegistry(extensionDir)
  const extensionStorage = new ExtensionStorage(extensionDir)

  const releaseSession = (kind: TabKind): void => {
    if (kind === 'normal') return
    protection.clearSession(kind)
    nip07Service?.clearEphemeral(kind)
    extensions?.onSessionReleased(kind)
    httpPolicies[kind].clearEphemeral()
    downloads.clearFor(kind)
    activeServices[kind].clear()
    endpointOwners[kind].clear()
    if (kind === 'private') privateResolver.clearCache()
    else torResolver.clearCache()
    nsiteResolvers[kind].clearCache()
    nsiteBlobs[kind].clear()
    void clearContentSession(content[kind]).catch((error) =>
      console.warn(`[session] could not clear the ${kind} session:`, error)
    )
  }

  const protocolDeps = (kind: TabKind, kindResolver: NccResolver) => ({
    session: content[kind],
    resolver: kindResolver,
    pins,
    health,
    transport,
    tor,
    httpPolicy: httpPolicies[kind],
    isTorService: (pubkey: string, service: string) =>
      shell?.isTorService(pubkey, service) ?? false,
    activeService: activeServices[kind],
    endpointOwners: endpointOwners[kind],
    onActivity: (activity: ProtocolActivity) => shell?.reportActivity(activity)
  })
  installNccProtocol(protocolDeps('normal', resolver))
  installNccProtocol(protocolDeps('private', privateResolver))
  installNccProtocol({
    ...protocolDeps('tor', torResolver),
    forceTor: true,
    strictTor: false
  })
  for (const kind of ['normal', 'private', 'tor'] as const) {
    installNsiteProtocol({
      session: content[kind],
      resolver: nsiteResolvers[kind],
      blobs: nsiteBlobs[kind],
      onActivity: (activity) => shell?.reportNsiteActivity(activity)
    })
  }
  installExtensionProtocol(
    [content.normal, content.private, content.tor, content.extensions],
    extensionRegistry
  )

  const bookmarks = new BookmarkStore(join(app.getPath('userData'), 'bookmarks.json'))
  const history = new HistoryStore(join(app.getPath('userData'), 'history.json'))
  const omnibox = new OmniboxService({
    history,
    bookmarks,
    config: () => config.get()
  })
  const sessionStore = new SessionStore(join(app.getPath('userData'), 'session.json'))
  const initialSession = sessionStore.load()

  const invalidateSite = (rawUrl: string, kind: TabKind): void => {
    try {
      const parsed = parseNccAddress(rawUrl)
      const resolver =
        kind === 'private' ? privateResolver : kind === 'tor' ? torResolver : resolvers[0]
      resolver.invalidate(parsed.pubkey, parsed.service)
      return
    } catch {
      // Not an NCC address; try nsite below.
    }
    try {
      const parsed = parseNsiteAddress(rawUrl)
      nsiteResolvers[kind].invalidate(parsed.pubkey, parsed.site)
    } catch {
      // Neither scheme: nothing to invalidate.
    }
  }

  let createShellWindow: (saved?: SavedSession | null, bounds?: { x: number; y: number }) => BrowserShell
  const shellDeps: Omit<ShellDeps, 'initialSession' | 'initialBounds' | 'deferInitialTabs'> = {
    preloadPath: join(__dirname, '../preload/index.js'),
    contentPreloadPath: join(__dirname, '../preload/content.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    activeServices,
    httpPolicies,
    omnibox,
    partitionFor,
    releaseSession,
    bookmarks,
    sessionStore,
    transport,
    tor,
    torGuard,
    protectionScriptForUrl: (url, kind) => protection.cosmeticScript(url, kind),
    health,
    preferTor: () => config.get().preferTor,
    appearance: () => config.get().appearance,
    onContentWebContents: (contents) => {
      // Remote content must never be able to keep the window from closing.
      contents.on('will-prevent-unload', (event) => event.preventDefault())
    },
    extensionContextItems: (url) => extensions?.contextMenuItems(url) ?? [],
    invalidateSite,
    onHostedResolved: (activity) => {
      if (!activity.locator?.encrypted) return
      const owner = toHexPubkey(activity.pubkey)
      if (!owner) return
      hosting.recordReceived({
        owner,
        dTag: activity.locator.dTag,
        expiresAt: activity.locator.expiresAt,
        ...(activity.locator.notes ? { title: activity.locator.notes } : {}),
        encrypted: true
      })
    },
    createWindow: (bounds) => createShellWindow(null, bounds),
    onSessionChanged: () => sessionStore.saveWindows(browserShells().map((entry) => entry.sessionSnapshot()))
  }
  shell = new BrowserShell({ ...shellDeps, initialSession })
  createShellWindow = (saved, bounds) => {
    const child = new BrowserShell({
      ...shellDeps,
      initialSession: saved,
      initialBounds: bounds,
      deferInitialTabs: !saved
    })
    child.loadChrome()
    return child
  }
  createFallbackShell = () => createShellWindow(null)
  for (const saved of initialSession?.windows ?? []) {
    createShellWindow({ version: 1, ...saved, savedAt: initialSession?.savedAt ?? 0 })
  }
  installShellCameraPermission(shell.window.webContents.session, () => shell!.window.webContents, process.env.ELECTRON_RENDERER_URL)
  installSitePermissionPrompts([
    { session: content.normal, kind: 'normal' },
    { session: content.private, kind: 'private' },
    { session: content.tor, kind: 'tor' }
  ], () => shell!.window, sitePermissions)

  const approvals = new ApprovalBroker({
    send: (channel, payload) => {
      if (!shell || shell.window.isDestroyed()) return false
      shell.window.webContents.send(channel, payload)
      return true
    },
    setOverlay: (visible) => {
      if (!shell) return
      shell.setOverlay('approval', visible)
      if (visible && !shell.window.isDestroyed()) {
        // Agent approvals can originate while the browser is behind another window.
        // Surface the request so the user can actually answer the permission prompt.
        shell.window.show()
        shell.window.focus()
      }
    },
    timeoutMs: 120_000
  })

  const passwordService = new PasswordService({
    config,
    identity,
    relays: relayPool,
    cache: new PasswordCache(join(app.getPath('userData'), 'passwords.json')),
    host: shell,
    clipboard: electronClipboard(),
    dialogs: electronFileDialogs(shell),
    onLock: () => paymentCards?.lock()
  })
  passwords = passwordService
  paymentCards = new PaymentCardService({
    identity,
    relays: relayPool,
    host: shell,
    cache: new PaymentCardCache(join(app.getPath('userData'), 'payment-cards.json')),
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
        config.setPasswordConfig({ allowNostrPaymentCardAuth: true, defaultNostrPaymentCardAuth: enabled })
      }
    }
  })
  registerPasswordIpc(passwordService, {
    shell,
    afterUnlock: () => paymentCards!.unlock(),
    afterConfigChange: async (input) => {
      if (typeof input.savePaymentCardSecurityCodes === 'boolean') await paymentCards!.setSecurityCodeSaving(input.savePaymentCardSecurityCodes)
    }
  })
  registerPaymentCardIpc(paymentCards, shell)
  walletService = new WalletService(
    join(app.getPath('userData'), 'wallet-prefs.json'),
    localIdentity,
    identity,
    () => config.get().preferTor ? torManager?.status().proxy ?? null : null,
    undefined,
    join(app.getPath('userData'), 'monero-wallet.json'),
    () => {
      const pubkey = identity.status().hexPubkey
      return pubkey ? passwordService.relaysFor(pubkey) : config.get().relays.map((relay) => relay.url).filter(Boolean)
    },
    relayPool
  )
  registerWalletIpc(walletService, shell)
  nwcService = new NwcService(
    join(app.getPath('userData'), 'nwc-connection.json'), relayPool,
    (value) => {
      if (!encryptionAvailable) throw new Error('Secure storage is unavailable on this system')
      return safeStorage.encryptString(value).toString('base64')
    },
    (value) => {
      if (!encryptionAvailable) throw new Error('Secure storage is unavailable on this system')
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
  )
  registerNwcIpc(nwcService, shell, content)
  shell.window.webContents.on('did-finish-load', () => passwordService.clearOverlays())
  shell.window.on('focus', () => void passwordService.onWindowFocus())

  const browserShell = shell
  const syncService = new SyncService({
    prefs: new SyncPrefsStore(join(app.getPath('userData'), 'sync.json')),
    identity,
    relays: relayPool,
    resolveRelays: (pubkey) => passwordService.relaysFor(pubkey),
    bookmarks,
    history,
    tabs: () => browserShell.syncTabs(),
    platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
    notify: (status) => {
      if (browserShell.window.isDestroyed()) return
      browserShell.sendToChrome('ncc:sync-status', status)
      browserShell.sendToChrome('ncc:bookmarks', bookmarks.list())
    }
  })
  browserShell.onTabsChanged = () => syncService.tabsChanged()
  registerSyncIpc(syncService, { shell: browserShell, openTab: (url) => browserShell.newTab(url) })
  browserShell.window.on('focus', () => syncService.onWindowFocus())
  syncService.start()

  nip07Service = new Nip07Service({
    identity,
    permissions,
    approvals,
    getRelays: () => config.getRelays(),
    autoApprove: process.env.NCC_SIGNER_AUTO_APPROVE === '1',
    useEphemeralSigner: () => config.get().ephemeralSigner
  })
  registerNip07(nip07Service, [
    { session: content.normal, kind: 'normal' },
    { session: content.private, kind: 'private' },
    { session: content.tor, kind: 'tor' }
  ])

  const extensionService = new ExtensionService({
    registry: extensionRegistry,
    storage: extensionStorage,
    host: shell,
    nip07: () => nip07Service,
    preloadPath: join(__dirname, '../preload/content.js'),
    partition: EXTENSION_PARTITION
  })
  extensions = extensionService
  registerExtensionIpc(extensionService, { shell })
  extensionService.start()

  const siteDataService = new SiteDataService({
    host: shell,
    config,
    permissions,
    sitePermissions,
    sessions: { normal: content.normal, private: content.private, tor: content.tor },
    extensionSession: content.extensions,
    locators: {
      count: () => cacheStore.size(),
      clear: () => {
        for (const value of resolvers) value.clearCache()
        cacheStore.clear()
      },
      invalidate: (kind, pubkey, service) => invalidateSite(
        `ncc://${pubkey}${service ? `/${service}` : ''}`,
        kind
      )
    }
  })
  registerSiteDataIpc(siteDataService, { shell })

  shell.window.on('closed', () => approvals.cancelAll())

  // Theme source changes (and OS theme changes in "system" mode) update the native
  // window background; the chrome follows through `prefers-color-scheme`.
  nativeTheme.on('updated', () => shell?.applyAppearance())

  // Re-resolve identity-backed relays before their locators expire. A rotation
  // updates the config, moves the TLS pin and drops the old pool connection.
  relaySync = new RelaySync({
    entries: () => config.getRelayEntries(),
    refresh: (entry) => relayLocator.refresh(entry),
    apply: (previousUrl, next) => {
      const updated = config.replaceRelayEntry(previousUrl, next)
      relayPins.clearUrl(previousUrl)
      relayPins.setForEntry(next)
      if (next.url !== previousUrl) relayPool.closeUrls([previousUrl])
      for (const value of resolvers) value.clearCache()
      shell?.sendConfig(updated)
    },
    markStale: (url, stale) => {
      shell?.sendConfig(config.markRelayStale(url, stale))
    },
    refreshExtra: async () => {
      await identity.refreshBunkerRelays((entry) => relayLocator.refresh(entry))
    },
    onError: (error) => console.warn('[relay-sync]', error)
  })

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
    protection,
    resolvers,
    pins,
    relayPins,
    relayLocator,
    relayPool,
    cacheStore,
    health,
    transport,
    tor,
    identity,
    permissions,
    approvals,
    downloads,
    passwords: passwordService,
    hosting,
    onion: onionManager
  })

  registerNsitePublishIpc(nsitePublish, shell)
  registerContactsIpc(contacts, shell)

  const hostingRenewal = setInterval(() => void hosting.renewDue(), 6 * 3600_000)
  hostingRenewal.unref()
  const hostingStartup = setTimeout(() => void hosting.renewDue(), 5_000)
  hostingStartup.unref()

  // Optional launch address: `ncc-browser ncc://npub1…/service`. A fresh launch uses
  // the restored blank tab; a real restored session gets the address in a new tab.
  const startupAddress = findStartupAddress()
  if (startupAddress) {
    const hasRestoredPages = initialSession?.tabs.some((tab) => tab.url) ?? false
    shell.window.webContents.once('did-finish-load', () => {
      if (hasRestoredPages) shell?.newTab(startupAddress)
      else void shell?.navigate(startupAddress)
    })
  }

  // Agent control: a loopback MCP server that lets a client such as Claude Code drive
  // ordinary tabs. Off until enabled in Settings (or NCC_AUTOMATION=1); docs/automation.md.
  const automation = new AutomationController({
    settings: new AutomationSettings(join(app.getPath('userData'), 'automation-settings.json')),
    host: createElectronHost(shell),
    approvals,
    version: app.getVersion(),
    infoFile: join(app.getPath('userData'), 'automation.json'),
    forced: process.env.NCC_AUTOMATION === '1',
    autoApprove: process.env.NCC_AUTOMATION_AUTO_APPROVE === '1',
    ...(Number(process.env.NCC_AUTOMATION_PORT) > 0
      ? { port: Number(process.env.NCC_AUTOMATION_PORT) }
      : {}),
    onChange: (state) => shell?.sendToChrome('ncc:automation-state', state)
  })
  registerAutomationIpc(automation, { shell })
  void automation.sync().catch((error) => console.warn('[automation] could not start:', error))
  app.on('before-quit', () => automation.shutdown())

  shell.loadChrome()
  relaySync?.start()
  if (pendingExternalUrl) {
    void shell.navigate(pendingExternalUrl)
    pendingExternalUrl = null
  }

  app.on('second-instance', (_event, argv) => {
    let target = browserShells()[0] ?? null
    if (!target && createFallbackShell) {
      target = createFallbackShell()
    }
    if (!target) return
    if (target.window.isMinimized()) target.window.restore()
    target.window.focus()
    const address = argv.find((arg) => /^(ncc|https?):\/\//i.test(arg))
    if (address) void target.navigate(address)
  })

})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  const target = browserShells()[0] ?? createFallbackShell?.() ?? null
  if (!target) return
  target.window.show()
  target.window.focus()
})

app.on('before-quit', () => {
  shell?.saveSessionNow()
  passwords?.dispose()
  walletService?.dispose()
  nwcService?.dispose()
  extensions?.dispose()
  void onionManager?.shutdown()
  relaySync?.stop()
  closeSharedPool()
  void torManager?.stop()
  torRelays?.close()
})

/** Packaged Tor binary, with a repo-local resources directory for development. */
function torBinaryPath(): string | null {
  const override = process.env.NCC_TOR_BINARY?.trim()
  if (override) return existsSync(override) ? override : null

  const platform =
    process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  const binary = process.platform === 'win32' ? 'tor.exe' : 'tor'
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  const candidates = app.isPackaged
    ? [join(base, 'tor', 'tor', binary)]
    : [join(base, 'tor', `${platform}-${process.arch}`, 'tor', binary)]
  return candidates.find(existsSync) ?? null
}

/** A URL passed on the command line opens on launch. */
function findStartupAddress(): string | null {
  return process.argv.find((arg) => /^(ncc|nsite|https?):\/\//i.test(arg)) ?? null
}

/**
 * Optional decryption key for encrypted locators. v0.1 ships without a keychain and
 * without a signer UI; this exists so targeted records can be tested deliberately.
 */
function locatorSignerFromEnv(): LocatorSigner | null {
  const raw = process.env.NCC_LOCATOR_NSEC?.trim()
  if (!raw) return null

  try {
    const secret = raw.startsWith('nsec1') ? decodeNsec(raw) : hexToBytes(raw)
    if (!secret || secret.length !== 32) throw new Error('expected 32-byte secret key')
    console.warn('[ncc] decrypting locators with NCC_LOCATOR_NSEC (development only)')
    return signerFromSecret(secret)
  } catch (error) {
    console.warn('[ncc] ignoring NCC_LOCATOR_NSEC:', error instanceof Error ? error.message : error)
    return null
  }
}

function decodeNsec(value: string): Uint8Array | null {
  const decoded = nip19.decode(value)
  return decoded.type === 'nsec' ? (decoded.data as Uint8Array) : null
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
