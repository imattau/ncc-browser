import { app, Menu, nativeTheme, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import type { TabKind } from '@shared/types'
import { ApprovalBroker } from './approval'
import { applyThemeSource } from './appearance'
import { BookmarkStore } from './bookmarks'
import { HistoryStore } from './history'
import { OmniboxService } from './omnibox'
import { LocatorCacheStore } from './cache-store'
import { ConfigStore } from './config'
import { DownloadManager } from './downloads'
import { registerIpc } from './ipc'
import { registerExtensionIpc } from './extensions/ipc'
import { installExtensionProtocol, registerExtensionScheme } from './extensions/protocol'
import { ExtensionRegistry } from './extensions/registry'
import { ExtensionService } from './extensions/runtime'
import { ExtensionStorage } from './extensions/storage'
import { PasswordCache } from './passwords/cache'
import { electronClipboard, electronFileDialogs, registerPasswordIpc } from './passwords/ipc'
import { PasswordService } from './passwords/service'
import { EndpointHealth } from './ncc/health'
import { closeSharedPool, NccResolver, signerFromSecret, type LocatorSigner } from './ncc/resolver'
import { installCertificatePinning, PinStore } from './pins'
import { installNccProtocol, registerNccScheme, type ProtocolActivity } from './protocol'
import { RelayLocatorService } from './relay/locator'
import { RelayPool } from './relay/pool'
import { RelayPinStore } from './relay/socket'
import { RelaySync } from './relay/sync'
import { BrowserShell } from './shell'
import { SessionStore } from './session-store'
import {
  clearContentSession,
  createContentSessions,
  EXTENSION_PARTITION,
  partitionFor,
  type ContentSessions
} from './sessions'
import { TransportPolicy } from './ncc/transport'
import { HttpPolicy } from './security'
import { TorGuard } from './tor/guard'
import { TorManager } from './tor/manager'
import { TorRelayPool } from './tor/relay'
import { TorSessionProxy } from './tor/session'
import { createBunkerRelay } from './signer/bunker-relay'
import { IdentityStore } from './signer/identity'
import { registerNip07 } from './signer/ipc'
import { IdentityManager } from './signer/manager'
import { PermissionStore } from './signer/permissions'
import { Nip07Service } from './signer/service'
import { Nip46SessionStore } from './signer/session'

// Custom schemes must be registered before the app is ready.
registerNccScheme()
registerExtensionScheme()

app.setName('Nostr Navigator')
// Keep the profile created by earlier NCC Browser builds across the rename.
app.setPath('userData', join(app.getPath('appData'), 'NCC Browser'))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let shell: BrowserShell | null = null
let contentSessions: ContentSessions | null = null
let torManager: TorManager | null = null
let torRelays: TorRelayPool | null = null
let relaySync: RelaySync | null = null
let passwords: PasswordService | null = null
let extensions: ExtensionService | null = null

app.whenReady().then(async () => {
  const config = new ConfigStore()
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
  const envLocatorSigner = locatorSignerFromEnv()

  // Relay entries resolved from NCC-05 locators are pinned by `host:port`; restore
  // the pins from the saved config before anything can connect.
  relayPins.setFromEntries(config.getRelayEntries())

  const relayPool = new RelayPool({
    pins: relayPins,
    proxy: () => torManager?.status().proxy ?? null
  })

  const resolverOptions = {
    relays: () => config.getRelays(),
    gossip: () => config.get().gossip,
    anchorRequired: () => config.get().anchorRequired,
    getSigner: () => identity.locatorSigner() ?? envLocatorSigner
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

  const relayLocator = new RelayLocatorService({
    resolver,
    entries: () => config.getRelayEntries(),
    torReady: () => torManager?.status().ready ?? false
  })

  const identity = await IdentityManager.create({
    local: localIdentity,
    sessions,
    encryptionAvailable,
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

  const content = createContentSessions()
  contentSessions = content
  for (const value of Object.values(content)) installCertificatePinning(value, pins)

  const torGuard = new TorGuard()
  torGuard.install(content.normal)
  torGuard.install(content.private)

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
    nip07Service?.clearEphemeral(kind)
    extensions?.onSessionReleased(kind)
    httpPolicies[kind].clearEphemeral()
    downloads.clearFor(kind)
    activeServices[kind].clear()
    endpointOwners[kind].clear()
    if (kind === 'private') privateResolver.clearCache()
    else torResolver.clearCache()
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
  installExtensionProtocol(
    [content.normal, content.private, content.tor, content.extensions],
    extensionRegistry
  )

  const bookmarks = new BookmarkStore(join(app.getPath('userData'), 'bookmarks.json'))
  const omnibox = new OmniboxService({
    history: new HistoryStore(join(app.getPath('userData'), 'history.json')),
    bookmarks,
    config: () => config.get()
  })
  const sessionStore = new SessionStore(join(app.getPath('userData'), 'session.json'))
  const initialSession = sessionStore.load()

  shell = new BrowserShell({
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
    initialSession,
    transport,
    tor,
    torGuard,
    health,
    preferTor: () => config.get().preferTor,
    appearance: () => config.get().appearance,
    onContentWebContents: (contents) => {
      // Remote content must never be able to keep the window from closing.
      contents.on('will-prevent-unload', (event) => event.preventDefault())
    },
    extensionContextItems: (url) => extensions?.contextMenuItems(url) ?? []
  })

  const approvals = new ApprovalBroker({
    send: (channel, payload) => {
      if (!shell || shell.window.isDestroyed()) return false
      shell.window.webContents.send(channel, payload)
      return true
    },
    setOverlay: (visible) => shell?.setOverlay('approval', visible),
    timeoutMs: 120_000
  })

  const passwordService = new PasswordService({
    config,
    identity,
    relays: relayPool,
    cache: new PasswordCache(join(app.getPath('userData'), 'passwords.json')),
    host: shell,
    clipboard: electronClipboard(),
    dialogs: electronFileDialogs(shell)
  })
  passwords = passwordService
  registerPasswordIpc(passwordService, { shell })
  shell.window.webContents.on('did-finish-load', () => passwordService.clearOverlays())
  shell.window.on('focus', () => void passwordService.onWindowFocus())

  nip07Service = new Nip07Service({
    identity,
    permissions,
    approvals,
    getRelays: () => config.getRelays(),
    autoApprove: process.env.NCC_SIGNER_AUTO_APPROVE === '1'
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
    passwords: passwordService
  })

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

  shell.loadChrome()
  relaySync?.start()

  app.on('second-instance', (_event, argv) => {
    if (!shell) return
    if (shell.window.isMinimized()) shell.window.restore()
    shell.window.focus()
    const address = argv.find((arg) => /^(ncc|https?):\/\//i.test(arg))
    if (address) void shell.navigate(address)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!shell) return
  if (shell.window.isDestroyed()) return
  shell.window.show()
})

app.on('before-quit', () => {
  shell?.saveSessionNow()
  passwords?.dispose()
  extensions?.dispose()
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
  return process.argv.find((arg) => /^(ncc|https?):\/\//i.test(arg)) ?? null
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
