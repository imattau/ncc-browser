import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import type { TabKind } from '@shared/types'
import { applyThemeSource } from '../appearance'
import { ContactsService } from '../contacts/service'
import { ContactsStore } from '../contacts/store'
import { ConfigStore } from '../config'
import { ExtensionRegistry } from '../extensions/registry'
import { ExtensionStorage } from '../extensions/storage'
import { HostingService } from '../hosting/service'
import { HostingStore } from '../hosting/store'
import { NetworkWatch } from '../hosting/network-watch'
import { PortMappingService } from '../hosting/port-mapping'
import { PortMonitor } from '../hosting/port-monitor'
import { PublicAddressService } from '../hosting/public-address'
import { queryGateway } from '../net/gateway'
import { RelayHostingPublisher } from '../hosting/relays'
import { EndpointHealth } from '../ncc/health'
import { NccResolver } from '../ncc/resolver'
import { NsitePublishService, RelayNsiteNetwork } from '../nsite-publish/service'
import { NsiteStore } from '../nsite-publish/store'
import { NsiteResolver } from '../nsite/resolver'
import { PinStore } from '../pins'
import { LocatorCacheStore } from '../cache-store'
import { ProtectionService } from '../protection'
import { RelayLocatorService } from '../relay/locator'
import { RelayPool } from '../relay/pool'
import { RelayPinStore } from '../relay/socket'
import { createBunkerRelay } from '../signer/bunker-relay'
import { IdentityStore } from '../signer/identity'
import { IdentityManager } from '../signer/manager'
import { PermissionStore } from '../signer/permissions'
import { Nip46SessionStore } from '../signer/session'
import { SitePermissionStore } from '../site-permissions'
import { TorRelayPool } from '../tor/relay'
import { broadcastToChrome } from './broadcast'
import { locatorSignerFromEnv } from './options'
import type { Runtime } from './runtime'

export interface Foundation {
  config: ConfigStore
  protection: ProtectionService
  pins: PinStore
  relayPins: RelayPinStore
  health: EndpointHealth
  cacheStore: LocatorCacheStore
  encryptionAvailable: boolean
  localIdentity: IdentityStore
  permissions: PermissionStore
  sitePermissions: SitePermissionStore
  relayPool: RelayPool
  resolver: NccResolver
  privateResolver: NccResolver
  torResolver: NccResolver
  resolvers: NccResolver[]
  nsiteResolvers: Record<TabKind, NsiteResolver>
  relayLocator: RelayLocatorService
  identity: IdentityManager
  hosting: HostingService
  publicAddress: PublicAddressService
  networkWatch: NetworkWatch
  portMonitor: PortMonitor
  contacts: ContactsService
  nsitePublish: NsitePublishService
  extensionRegistry: ExtensionRegistry
  extensionStorage: ExtensionStorage
}

/**
 * Services that exist for the whole session: config, identity, relays, resolution,
 * hosted services, contacts and site publishing. Nothing here needs a window.
 */
export async function createFoundation(runtime: Runtime): Promise<Foundation> {
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
      console.warn(
        '[signer] ignoring NCC_IDENTITY_NSEC:',
        error instanceof Error ? error.message : error
      )
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
    proxy: () => runtime.torManager?.status().proxy ?? null
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
  const torRelays = new TorRelayPool(relayPins)
  runtime.torRelays = torRelays
  const resolver = new NccResolver({
    ...resolverOptions,
    cacheStore,
    query: relayPool.query
  })
  const privateResolver = new NccResolver({ ...resolverOptions, query: relayPool.query })
  const torResolver = new NccResolver({ ...resolverOptions, query: torRelays.query })
  const resolvers = [resolver, privateResolver, torResolver]

  const nsiteRelays = () => config.get().relays.map((entry) => entry.url).filter(Boolean)
  const nsiteResolvers: Record<TabKind, NsiteResolver> = {
    normal: new NsiteResolver({ query: relayPool.query, relays: nsiteRelays }),
    private: new NsiteResolver({ query: relayPool.query, relays: nsiteRelays }),
    tor: new NsiteResolver({ query: torRelays.query, relays: nsiteRelays })
  }

  const relayLocator = new RelayLocatorService({
    resolver,
    entries: () => config.getRelayEntries(),
    torReady: () => runtime.torManager?.status().ready ?? false
  })

  const identity = await IdentityManager.create({
    local: localIdentity,
    sessions,
    encryptionAvailable,
    profilesPath: join(app.getPath('userData'), 'identity-profiles.json'),
    localFactory: (id) =>
      IdentityStore.open({
        filePath: join(app.getPath('userData'), 'identity-profiles', `local-${id}.json`),
        codec: identityCodec
      }),
    sessionFactory: (id) =>
      new Nip46SessionStore(
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
    onions: () => runtime.onionManager?.statuses() ?? [],
    onChange: (state) => broadcastToChrome(runtime, 'ncc:hosting-changed', state)
  })

  const publicAddress = new PublicAddressService()
  runtime.portMappings = new PortMappingService({
    filePath: join(app.getPath('userData'), 'port-mappings.json')
  })
  const networkWatch = new NetworkWatch({
    wanProbe: async () => {
      const gateway = await queryGateway({ timeoutMs: 1500 })
      return gateway.wanAddress ?? null
    },
    onChange: (change) => broadcastToChrome(runtime, 'ncc:network-changed', change)
  })
  networkWatch.start()
  app.on('before-quit', () => networkWatch.stop())
  const portMonitor = new PortMonitor({
    mappings: runtime.portMappings,
    tor: { status: () => runtime.torManager?.status() ?? { ready: false, proxy: null } },
    onChange: (event) => broadcastToChrome(runtime, 'ncc:port-status', event)
  })
  portMonitor.start()
  app.on('before-quit', () => portMonitor.stop())

  const contacts = new ContactsService({
    store: new ContactsStore(join(app.getPath('userData'), 'contacts.json')),
    relays: relayPool,
    config,
    owner: () => identity.status().hexPubkey ?? null,
    onChange: (state) => broadcastToChrome(runtime, 'ncc:contacts-changed', state)
  })

  const nsitePublish = new NsitePublishService({
    store: new NsiteStore(join(app.getPath('userData'), 'nsite-sites.json')),
    identity: {
      provider: () => identity.provider(),
      status: () => identity.status()
    },
    network: new RelayNsiteNetwork(relayPool, config),
    onChange: (state) => broadcastToChrome(runtime, 'ncc:nsite-changed', state)
  })

  const extensionDir = join(app.getPath('userData'), 'extensions')
  const extensionRegistry = new ExtensionRegistry(extensionDir)
  const extensionStorage = new ExtensionStorage(extensionDir)

  return {
    config,
    protection,
    pins,
    relayPins,
    health,
    cacheStore,
    encryptionAvailable,
    localIdentity,
    permissions,
    sitePermissions,
    relayPool,
    resolver,
    privateResolver,
    torResolver,
    resolvers,
    nsiteResolvers,
    relayLocator,
    identity,
    hosting,
    publicAddress,
    networkWatch,
    portMonitor,
    contacts,
    nsitePublish,
    extensionRegistry,
    extensionStorage
  }
}
