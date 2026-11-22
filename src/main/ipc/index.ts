import type { ApprovalBroker } from '../approval'
import type { LocatorCacheStore } from '../cache-store'
import type { ConfigStore } from '../config'
import type { DownloadManager } from '../downloads'
import type { HostingService } from '../hosting/service'
import type { NetworkWatch } from '../hosting/network-watch'
import type { PortMappingService } from '../hosting/port-mapping'
import type { PublicAddressService } from '../hosting/public-address'
import type { EndpointHealth } from '../ncc/health'
import type { NccResolver } from '../ncc/resolver'
import type { TransportPolicy } from '../ncc/transport'
import type { PasswordService } from '../passwords/service'
import type { PinStore } from '../pins'
import type { ProtectionService } from '../protection'
import type { RelayLocatorService } from '../relay/locator'
import type { RelayPool } from '../relay/pool'
import type { RelayPinStore } from '../relay/socket'
import type { BrowserShell } from '../shell'
import type { IdentityManager } from '../signer/manager'
import type { PermissionStore } from '../signer/permissions'
import type { OnionManager } from '../tor/onion'
import type { TorManager } from '../tor/manager'
import { registerHostingIpc } from '../hosting/ipc'
import { registerSignerChromeIpc } from '../signer/ipc-chrome'
import { registerTorIpc } from '../tor/ipc'
import { registerBrowserIpc } from './browser'
import { registerDownloadIpc } from './downloads'
import { registerSettingsIpc } from './settings'

/**
 * The service graph the chrome IPC surface is allowed to reach. Every registrar
 * declares a narrower interface of its own; this union exists so the composition
 * root can hand each one the same object.
 */
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
  onion: OnionManager
  publicAddress: PublicAddressService
  portMappings: PortMappingService
  network: NetworkWatch
}

/**
 * Register every `ncc:*` channel. Split by domain so the browser surface, browser
 * settings, downloads, hosting, identity/signer and Tor can be read separately.
 */
export function registerIpc(deps: IpcDeps): void {
  registerBrowserIpc(deps)
  registerSettingsIpc(deps)
  registerDownloadIpc(deps)
  registerHostingIpc(deps)
  registerSignerChromeIpc(deps)
  registerTorIpc(deps)
}
