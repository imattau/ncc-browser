import { app, Menu, safeStorage, session, type Session } from 'electron'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { ApprovalBroker } from './approval'
import { BookmarkStore } from './bookmarks'
import { LocatorCacheStore } from './cache-store'
import { ConfigStore } from './config'
import { DownloadManager } from './downloads'
import { registerIpc } from './ipc'
import { EndpointHealth } from './ncc/health'
import { closeSharedPool, NccResolver, signerFromSecret, type LocatorSigner } from './ncc/resolver'
import { installCertificatePinning, PinStore } from './pins'
import { installNccProtocol, registerNccScheme } from './protocol'
import { BrowserShell } from './shell'
import { SessionStore } from './session-store'
import { IdentityStore } from './signer/identity'
import { registerNip07 } from './signer/ipc'
import { IdentityManager } from './signer/manager'
import { PermissionStore } from './signer/permissions'
import { Nip07Service } from './signer/service'
import { Nip46SessionStore } from './signer/session'

// Custom schemes must be registered before the app is ready.
registerNccScheme()

const existingUserDataPath = app.getPath('userData')
app.setName('Nostr Navigator')
app.setPath('userData', existingUserDataPath)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const CONTENT_PARTITION = 'persist:ncc-content'

let shell: BrowserShell | null = null
let contentSession: Session | null = null

app.whenReady().then(async () => {
  const config = new ConfigStore()
  const pins = new PinStore()
  const health = new EndpointHealth()
  const cacheStore = new LocatorCacheStore(join(app.getPath('userData'), 'locator-cache.json'))
  const activeService = new Map<string, string>()
  const endpointOwners = new Map<string, { pubkey: string; service: string }>()

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
  const identity = await IdentityManager.create({
    local: localIdentity,
    sessions,
    encryptionAvailable,
    timeoutMs: Number(process.env.NCC_NIP46_TIMEOUT_MS) || 60_000
  })

  const permissions = new PermissionStore(
    join(app.getPath('userData'), 'signer-permissions.json')
  )
  const envLocatorSigner = locatorSignerFromEnv()

  const resolver = new NccResolver({
    relays: () => config.getRelays(),
    gossip: () => config.get().gossip,
    anchorRequired: () => config.get().anchorRequired,
    cacheStore,
    getSigner: () => identity.locatorSigner() ?? envLocatorSigner
  })

  contentSession = session.fromPartition(CONTENT_PARTITION)
  contentSession.setSpellCheckerEnabled(false)
  installCertificatePinning(contentSession, pins)

  const downloadDirectory = process.env.NCC_DOWNLOAD_DIR?.trim()
  const downloads = new DownloadManager({
    ...(downloadDirectory ? { directory: downloadDirectory } : {}),
    notify: (notice) => shell?.notifyDownload(notice)
  })
  downloads.install(contentSession)

  installNccProtocol({
    session: contentSession,
    resolver,
    pins,
    health,
    activeService,
    endpointOwners,
    onActivity: (activity) => shell?.reportActivity(activity)
  })

  const bookmarks = new BookmarkStore(join(app.getPath('userData'), 'bookmarks.json'))
  const sessionStore = new SessionStore(join(app.getPath('userData'), 'session.json'))
  const initialSession = sessionStore.load()

  shell = new BrowserShell({
    preloadPath: join(__dirname, '../preload/index.js'),
    contentPreloadPath: join(__dirname, '../preload/content.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    activeService,
    bookmarks,
    sessionStore,
    initialSession,
    onContentWebContents: (contents) => {
      // Remote content must never be able to keep the window from closing.
      contents.on('will-prevent-unload', (event) => event.preventDefault())
    }
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

  const nip07 = new Nip07Service({
    identity,
    permissions,
    approvals,
    getRelays: () => config.getRelays(),
    autoApprove: process.env.NCC_SIGNER_AUTO_APPROVE === '1'
  })
  registerNip07(nip07, contentSession)

  shell.window.on('closed', () => approvals.cancelAll())

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

  registerIpc({ shell, config, resolver, pins, cacheStore, health, identity, permissions, approvals, downloads })

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
  closeSharedPool()
})

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
