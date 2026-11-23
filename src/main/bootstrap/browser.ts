import { app } from 'electron'
import { join } from 'node:path'
import { parseNccAddress } from '@shared/ncc-url'
import { parseNsiteAddress } from '@shared/nsite-url'
import type { TabKind } from '@shared/types'
import { DownloadManager } from '../downloads'
import { installExtensionProtocol } from '../extensions/protocol'
import { NsiteBlobs } from '../nsite/blob'
import { installNsiteProtocol } from '../nsite/protocol'
import { installNccSearchProtocol } from '../nccsearch/protocol'
import { NccSearchUpdater } from '../nccsearch/update'
import { installNccProtocol, type ProtocolActivity } from '../protocol'
import { installCertificatePinning } from '../pins'
import { installSitePublisherProtocol } from '../site-publisher/protocol'
import { HttpPolicy } from '../security'
import { clearContentSession, createContentSessions, type ContentSessions } from '../sessions'
import { TorGuard } from '../tor/guard'
import { TorManager } from '../tor/manager'
import { OnionManager, verifyOnionThroughSocks } from '../tor/onion'
import { TorControl } from '../tor/control'
import { TorSessionProxy } from '../tor/session'
import { TransportPolicy } from '../ncc/transport'
import type { NccResolver } from '../ncc/resolver'
import { broadcastToChrome } from './broadcast'
import type { Foundation } from './foundation'
import { torBinaryPath } from './options'
import type { Runtime } from './runtime'

export interface BrowserStack {
  content: ContentSessions
  transport: TransportPolicy
  torGuard: TorGuard
  tor: TorManager
  downloads: DownloadManager
  httpPolicies: Record<TabKind, HttpPolicy>
  activeServices: Record<TabKind, Map<string, string>>
  endpointOwners: Record<TabKind, Map<string, { pubkey: string; service: string }>>
  nsiteBlobs: Record<TabKind, NsiteBlobs>
  releaseSession: (kind: TabKind) => void
  invalidateSite: (rawUrl: string, kind: TabKind) => void
  nccSearchUpdater: NccSearchUpdater
}

const KINDS = ['normal', 'private', 'tor'] as const

/**
 * Content sessions, the Tor runtime and the request protocols. Everything here either
 * owns a session or is installed on one; the shell only consumes the result.
 */
export async function createBrowserStack(
  runtime: Runtime,
  foundation: Foundation
): Promise<BrowserStack> {
  const { config, identity, protection, pins, health, resolver, privateResolver, torResolver } =
    foundation
  const torRelayPool = runtime.torRelays!
  const { resolvers, nsiteResolvers } = foundation

  const content = createContentSessions()
  runtime.contentSessions = content
  for (const [kind, value] of [
    ['normal', content.normal],
    ['private', content.private],
    ['tor', content.tor]
  ] as const) {
    installCertificatePinning(value, pins)
    protection.installCookiePolicy(value, kind)
  }

  const nccSearchAssets = app.isPackaged
    ? join(process.resourcesPath, 'nccsearch')
    : join(app.getAppPath(), 'resources', 'nccsearch')
  const nccSearchUpdater = new NccSearchUpdater(app.getPath('userData'), nccSearchAssets)
  installNccSearchProtocol(
    [content.normal, content.private, content.tor],
    () => nccSearchUpdater.activeDirectory(),
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
  const tor = new TorManager({
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
      foundation.relayPool.refresh()
      return torSessionProxy.apply(proxy)
    },
    ...(process.env.NCC_TOR_DEBUG === '1'
      ? { log: (line: string) => console.log('[tor]', line) }
      : {})
  })
  runtime.torManager = tor

  const onions = new OnionManager({
    filePath: join(app.getPath('userData'), 'tor-services.json'),
    tor: {
      ensureReady: () => tor.ensureReady(),
      controlEndpoint: () => tor.controlEndpoint(),
      proxy: () => tor.status().proxy
    },
    createControl: (endpoint) => new TorControl(endpoint),
    verify: verifyOnionThroughSocks,
    onChange: () => broadcastToChrome(runtime, 'ncc:hosting-changed', foundation.hosting.state()),
    ...(process.env.NCC_TOR_DEBUG === '1'
      ? { log: (line: string) => console.log('[onion]', line) }
      : {})
  })
  runtime.onionManager = onions
  tor.setReadyHook(() => {
    void onions.restoreAll().catch((error) => {
      console.warn('[onion] could not restore services:', error)
    })
  })
  // A published onion must exist for the locator to work; start Tor for it in the
  // background rather than waiting for an unrelated Tor use.
  if (onions.statuses().length > 0) {
    setTimeout(() => {
      void onions.restoreAll().catch((error) => {
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
    notify: (notice) => runtime.shell?.notifyDownload(notice)
  })
  downloads.install(content.normal, 'normal')
  downloads.install(content.private, 'private')
  downloads.install(content.tor, 'tor')

  const blobDirectory = join(app.getPath('userData'), 'nsite-blobs')
  const nsiteBlobs: Record<TabKind, NsiteBlobs> = {
    normal: new NsiteBlobs({
      fetch: (url, init) => content.normal.fetch(url, init),
      directory: blobDirectory
    }),
    private: new NsiteBlobs({ fetch: (url, init) => content.private.fetch(url, init), directory: null }),
    tor: new NsiteBlobs({ fetch: (url, init) => content.tor.fetch(url, init), directory: null })
  }

  const releaseSession = (kind: TabKind): void => {
    if (kind === 'normal') return
    protection.clearSession(kind)
    runtime.nip07Service?.clearEphemeral(kind)
    runtime.extensions?.onSessionReleased(kind)
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
      runtime.shell?.isTorService(pubkey, service) ?? false,
    activeService: activeServices[kind],
    endpointOwners: endpointOwners[kind],
    onActivity: (activity: ProtocolActivity) => runtime.shell?.reportActivity(activity)
  })
  installNccProtocol(protocolDeps('normal', resolver))
  installNccProtocol(protocolDeps('private', privateResolver))
  installNccProtocol({
    ...protocolDeps('tor', torResolver),
    forceTor: true,
    strictTor: false
  })
  for (const kind of KINDS) {
    installNsiteProtocol({
      session: content[kind],
      resolver: nsiteResolvers[kind],
      blobs: nsiteBlobs[kind],
      onActivity: (activity) => runtime.shell?.reportNsiteActivity(activity)
    })
  }
  installExtensionProtocol(
    [content.normal, content.private, content.tor, content.extensions],
    foundation.extensionRegistry
  )

  const invalidateSite = (rawUrl: string, kind: TabKind): void => {
    try {
      const parsed = parseNccAddress(rawUrl)
      const target =
        kind === 'private' ? privateResolver : kind === 'tor' ? torResolver : resolvers[0]
      target.invalidate(parsed.pubkey, parsed.service)
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

  return {
    content,
    transport,
    torGuard,
    tor,
    downloads,
    httpPolicies,
    activeServices,
    endpointOwners,
    nsiteBlobs,
    releaseSession,
    invalidateSite,
    nccSearchUpdater
  }
}
