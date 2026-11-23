import type { BrowserShell } from '../shell'
import type { ContentSessions } from '../sessions'
import type { AutomationController } from '../automation/controller'
import type { ExtensionService } from '../extensions/runtime'
import type { NwcService } from '../wallet/nwc-service'
import type { OnionManager } from '../tor/onion'
import type { PasswordService } from '../passwords/service'
import type { PaymentCardService } from '../payment-cards/service'
import type { PortMappingService } from '../hosting/port-mapping'
import type { RelaySync } from '../relay/sync'
import type { TorManager } from '../tor/manager'
import type { TorRelayPool } from '../tor/relay'
import type { WalletService } from '../wallet/service'
import type { Nip07Service } from '../signer/service'

/**
 * The few objects the app lifecycle handlers need after startup: the primary window,
 * the services that hold OS resources, and the startup URL macOS may deliver before the
 * first window exists. Replacing the thirteen module-level `let`s with one typed
 * container makes the dependency explicit and keeps `index.ts` about ordering.
 */
export interface Runtime {
  shell: BrowserShell | null
  createFallbackShell: (() => BrowserShell) | null
  contentSessions: ContentSessions | null
  torManager: TorManager | null
  onionManager: OnionManager | null
  portMappings: PortMappingService | null
  torRelays: TorRelayPool | null
  relaySync: RelaySync | null
  passwords: PasswordService | null
  paymentCards: PaymentCardService | null
  walletService: WalletService | null
  nwcService: NwcService | null
  extensions: ExtensionService | null
  nip07Service: Nip07Service | null
  automation: AutomationController | null
  pendingExternalUrl: string | null
}

export function createRuntime(): Runtime {
  return {
    shell: null,
    createFallbackShell: null,
    contentSessions: null,
    torManager: null,
    onionManager: null,
    portMappings: null,
    torRelays: null,
    relaySync: null,
    passwords: null,
    paymentCards: null,
    walletService: null,
    nwcService: null,
    extensions: null,
    nip07Service: null,
    automation: null,
    pendingExternalUrl: null
  }
}
