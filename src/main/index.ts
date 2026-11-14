import { app, session, type Session } from 'electron'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { LocatorCacheStore } from './cache-store'
import { ConfigStore } from './config'
import { installDownloadHandler } from './downloads'
import { registerIpc } from './ipc'
import { EndpointHealth } from './ncc/health'
import { closeSharedPool, NccResolver, signerFromSecret, type LocatorSigner } from './ncc/resolver'
import { installCertificatePinning, PinStore } from './pins'
import { installNccProtocol, registerNccScheme } from './protocol'
import { BrowserShell } from './shell'

// Custom schemes must be registered before the app is ready.
registerNccScheme()

app.setName('NCC Browser')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const CONTENT_PARTITION = 'persist:ncc-content'

let shell: BrowserShell | null = null
let contentSession: Session | null = null

app.whenReady().then(() => {
  const config = new ConfigStore()
  const pins = new PinStore()
  const health = new EndpointHealth()
  const cacheStore = new LocatorCacheStore(join(app.getPath('userData'), 'locator-cache.json'))
  const activeService = new Map<string, string>()
  const endpointOwners = new Map<string, { pubkey: string; service: string }>()

  const resolver = new NccResolver({
    relays: () => config.getRelays(),
    gossip: () => config.get().gossip,
    cacheStore,
    signer: locatorSignerFromEnv()
  })

  contentSession = session.fromPartition(CONTENT_PARTITION)
  contentSession.setSpellCheckerEnabled(false)
  installCertificatePinning(contentSession, pins)

  installNccProtocol({
    session: contentSession,
    resolver,
    pins,
    health,
    activeService,
    endpointOwners,
    onActivity: (activity) => shell?.reportActivity(activity)
  })

  installDownloadHandler(contentSession, {
    notify: (notice) => shell?.notifyDownload(notice)
  })

  shell = new BrowserShell({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    activeService,
    onContentWebContents: (contents) => {
      // Remote content must never be able to keep the window from closing.
      contents.on('will-prevent-unload', (event) => event.preventDefault())
    }
  })

  registerIpc({ shell, config, resolver, pins, cacheStore, health })

  // Optional launch address: `ncc-browser ncc://npub1…/service`
  const startupAddress = findStartupAddress()
  if (startupAddress) {
    shell.window.webContents.once('did-finish-load', () => {
      void shell?.navigate(startupAddress)
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
