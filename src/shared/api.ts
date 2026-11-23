import type { AutomationState } from './automation'
import type { CommandId } from './commands'
import type { SyncPrefsPatch, SyncStatus } from './sync-status'
import type {
  ExtensionInstallResult,
  ExtensionsState
} from './extensions'
import type {
  CacheInfo,
  SiteDataClearOptions,
  SiteDataClearResult,
  SiteDataInfo
} from './site-data'
import type { SearchEngineId } from './search'
import type { ContactsState } from './contacts'
import type {
  NsiteCancelled,
  NsiteDiscoverResult,
  NsiteFolderScan,
  NsiteProgress,
  NsitePublishInput,
  NsitePublishResult,
  NsitePublishState,
  NsiteRemoveResult,
  NsiteVerifyResult
} from './nsite-publish'
import type {
  CertificateInfo,
  GeneratedCertificate,
  HostingDraft,
  HostingOnionResult,
  HostingPublishResult,
  HostingShareBatchResult,
  HostingShareResult,
  HostingState
} from './hosting'
import type {
  NetworkChange,
  PortMapping,
  PortStatusEvent,
  ReachabilityReport
} from './reachability'
import type {
  AppearanceConfig,
  AppConfig,
  AppInfo,
  Bookmark,
  DownloadNotice,
  IdentityStatus,
  IdentityList,
  NavState,
  OmniboxSuggestion,
  OverlayReason,
  HttpsMode,
  TabKind,
  RelayEntry,
  RelayLocatorOutcome,
  SignerPermission,
  SignerOriginState,
  SignerRequest,
  TabHistory,
  TorMode,
  TorStatus
} from './types'
import type {
  PasswordConfig,
  PasswordContext,
  PasskeyConfirmationRequest,
  PasswordCopyResult,
  PasswordDraft,
  PasswordEntry,
  PasswordExportResult,
  PasswordFillResult,
  PasswordGeneratorOptions,
  PasswordHealthReport,
  PasswordImportPreview,
  PasswordSaveRequest,
  PasswordSaveResult,
  PasswordSummary,
  PasswordToast,
  PasswordTotpCode,
  PasswordVaultStatus
} from './passwords'
import type {
  PaymentCardDraft,
  PaymentCardSaveRequest,
  PaymentCardSettingsStatus,
  PaymentCardSummary
} from './payment-cards'
import type { BitcoinSendPreview, MoneroWalletRecord, NwcInvoiceLookup, NwcSnapshot, WalletSnapshot, WalletStatus } from './wallet'

export interface SetRelaysResult {
  ok: boolean
  config?: AppConfig
  error?: string
}

export type SetAppearanceResult = SetRelaysResult

/**
 * The only surface the chrome renderer gets. Remote content never sees any of it:
 * each content view is a separate, sandboxed WebContents with no preload.
 */
export interface NccApi {
  /** Appearance resolved before the first paint; safe to read synchronously. */
  readonly initialAppearance: AppearanceConfig
  navigate(input: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  forceReload(): Promise<void>
  stop(): Promise<void>
  toggleTor(): Promise<void>
  insecureChoice(choice: 'cancel' | 'continue' | 'always'): Promise<void>
  newTab(input?: string): Promise<string>
  newPrivateTab(input?: string): Promise<string>
  newTorTab(input?: string): Promise<string>
  closeTab(id?: string): Promise<void>
  selectTab(id: string): Promise<void>
  moveTab(id: string, toIndex: number): Promise<void>
  detachTab(id: string, screenX: number, screenY: number): Promise<void>
  duplicateTab(id?: string): Promise<void>
  reloadTab(id?: string): Promise<void>
  toggleMute(id?: string): Promise<void>
  closeOtherTabs(id?: string): Promise<void>
  closeTabsToRight(id?: string): Promise<void>
  showTabMenu(id: string): Promise<void>
  showNewTabMenu(): Promise<void>
  tabHistory(id?: string): Promise<TabHistory>
  goToHistoryIndex(index: number): Promise<void>
  clearHistory(): Promise<void>
  showHistoryMenu(direction: 'back' | 'forward'): Promise<void>
  getState(): Promise<NavState>
  getConfig(): Promise<AppConfig>
  bookmarks(): Promise<Bookmark[]>
  toggleBookmark(): Promise<Bookmark[]>
  removeBookmark(url: string): Promise<Bookmark[]>
  downloads(): Promise<DownloadNotice[]>
  cancelDownload(id: string): Promise<DownloadNotice[]>
  revealDownload(id: string): Promise<void>
  clearDownloads(): Promise<DownloadNotice[]>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  setRelays(relays: Array<string | RelayEntry>): Promise<SetRelaysResult>
  resolveRelayLocator(input: string): Promise<RelayLocatorOutcome>
  setGossip(value: boolean): Promise<SetRelaysResult>
  setAnchorRequired(value: boolean): Promise<SetRelaysResult>
  setExternalAddressChecks(value: import('./types').ExternalAddressCheck): Promise<SetRelaysResult>
  setPreferTor(value: boolean): Promise<SetRelaysResult>
  setEphemeralSigner(value: boolean): Promise<SetRelaysResult>
  setTorMode(mode: TorMode): Promise<SetRelaysResult>
  setTorSocks(socks: string): Promise<SetRelaysResult>
  setTorConfig(config: {
    preferTor: boolean
    mode: TorMode
    socks: string
  }): Promise<SetRelaysResult>
  setSecurityConfig(config: {
    httpsMode: HttpsMode
    warnInsecure: boolean
    protection?: Partial<import('./types').ProtectionConfig>
  }): Promise<SetRelaysResult>
  setProtectionException(origin: string, allowed: boolean, kind: TabKind): Promise<AppConfig>
  protectionSummary(url: string, kind: TabKind): Promise<{ level: import('./types').ProtectionLevel; blocked: number; excepted: boolean }>
  removeHttpException(key: string): Promise<AppConfig>
  clearHttpExceptions(): Promise<AppConfig>
  omniboxSuggest(input: string): Promise<OmniboxSuggestion[]>
  clearBrowsingHistory(): Promise<void>
  siteData(): Promise<SiteDataInfo>
  clearSiteData(options: SiteDataClearOptions): Promise<SiteDataClearResult>
  cacheInfo(): Promise<CacheInfo>
  clearCache(): Promise<CacheInfo>
  reResolveSite(): Promise<boolean>
  setSearchConfig(config: {
    engine: SearchEngineId
    custom: string
    useOnionSearch: boolean
    nccSearchEnabled: boolean
  }): Promise<SetRelaysResult>
  setAppearance(appearance: Partial<AppearanceConfig>): Promise<SetAppearanceResult>
  hostingState(): Promise<HostingState>
  hostingCreate(draft: HostingDraft): Promise<HostingState>
  hostingUpdate(id: string, draft: HostingDraft): Promise<HostingState>
  hostingRemove(id: string): Promise<HostingState>
  hostingPublish(id: string): Promise<HostingPublishResult>
  hostingShare(id: string, recipient: string, days: number, label?: string): Promise<HostingShareResult>
  hostingShareMany(id: string, recipients: string[], days: number, label?: string): Promise<HostingShareBatchResult>
  hostingRevokeShare(shareId: string): Promise<HostingShareResult>
  hostingForgetReceived(id: string): Promise<HostingState>
  hostingDiscoverEndpoints(
    seedUrl: string,
    options?: { external?: boolean; port?: number; secure?: boolean }
  ): Promise<ReachabilityReport>
  hostingMapPort(input: {
    localPort: number
    secure?: boolean
    externalPort?: number
  }): Promise<PortMapping>
  hostingUnmapPort(localPort: number): Promise<void>
  hostingVerifyPort(localPort: number): Promise<PortMapping | null>
  hostingPortMappings(): Promise<PortMapping[]>
  hostingNetworkChanges(): Promise<NetworkChange[]>
  hostingReplaceAddress(
    from: string,
    to: string,
    publish?: boolean
  ): Promise<{
    state: HostingState
    updated: number
    ids: string[]
    failures: Array<{ id: string; title?: string; error: string }>
  }>
  onNetworkChanged(listener: (change: NetworkChange) => void): () => void
  onPortStatus(listener: (event: PortStatusEvent) => void): () => void
  hostingPublishOnion(serviceId: string): Promise<HostingOnionResult>
  hostingRemoveOnion(serviceId: string): Promise<HostingState>
  hostingImportCertificate(): Promise<CertificateInfo | null>
  hostingGenerateCertificate(input: {
    commonName: string
    altNames?: string[]
    days?: number
  }): Promise<GeneratedCertificate | null>
  onHostingChanged(listener: (state: HostingState) => void): () => void
  nsiteState(): Promise<NsitePublishState>
  nsiteDiscover(): Promise<NsiteDiscoverResult>
  nsitePickFolder(): Promise<NsiteFolderScan | null>
  nsitePublish(input: NsitePublishInput): Promise<NsitePublishResult | NsiteCancelled>
  nsiteVerify(id: string): Promise<NsiteVerifyResult | NsiteCancelled>
  nsiteCancel(): Promise<boolean>
  nsiteRemove(id: string): Promise<NsiteRemoveResult>
  onNsiteProgress(listener: (progress: NsiteProgress) => void): () => void
  onNsiteChanged(listener: (state: NsitePublishState) => void): () => void
  syncStatus(): Promise<SyncStatus>
  contactsState(): Promise<ContactsState>
  contactsRefresh(): Promise<ContactsState>
  onContactsChanged(listener: (state: ContactsState) => void): () => void
  syncNow(): Promise<SyncStatus>
  syncConfigure(patch: SyncPrefsPatch): Promise<SyncStatus>
  syncRemoveDevice(id: string): Promise<SyncStatus>
  syncOpenTab(url: string): Promise<void>
  onSyncStatus(listener: (status: SyncStatus) => void): () => void
  passwordsStatus(): Promise<PasswordVaultStatus>
  passwordsContext(): Promise<PasswordContext>
  passwordsUnlock(): Promise<PasswordVaultStatus>
  passwordsLock(): Promise<PasswordVaultStatus>
  passwordsList(): Promise<PasswordSummary[]>
  passwordsHealth(): Promise<PasswordHealthReport>
  passwordsEntry(id: string): Promise<PasswordEntry | null>
  passwordsReveal(id: string): Promise<string>
  passwordsTotp(id: string): Promise<PasswordTotpCode>
  passwordsCopy(id: string, field: 'username' | 'password' | 'totp'): Promise<PasswordCopyResult>
  passwordsGenerate(options: PasswordGeneratorOptions): Promise<string>
  passwordsSave(entry: PasswordDraft): Promise<PasswordSaveResult>
  passwordsRemove(id: string): Promise<PasswordSaveResult>
  passwordsSync(): Promise<PasswordVaultStatus>
  passwordsFill(id: string): Promise<PasswordFillResult>
  passwordsSetConfig(config: Partial<PasswordConfig>): Promise<PasswordVaultStatus>
  passwordsRemoveNever(origin: string): Promise<PasswordVaultStatus>
  passwordsRespond(id: string, action: 'save' | 'never' | 'dismiss'): Promise<PasswordSaveResult>
  passwordsImportOpen(): Promise<PasswordImportPreview>
  passwordsImportCommit(
    id: string,
    mode: 'merge' | 'skip' | 'add'
  ): Promise<PasswordSaveResult>
  passwordsExport(format: 'encrypted' | 'csv'): Promise<PasswordExportResult>
  paymentCardsStatus(): Promise<PaymentCardSettingsStatus>
  paymentCardsList(): Promise<PaymentCardSummary[]>
  paymentCardsSave(card: PaymentCardDraft): Promise<{ ok: boolean; pending?: boolean; error?: string }>
  paymentCardsRemove(id: string): Promise<{ ok: boolean; error?: string }>
  paymentCardsSync(): Promise<void>
  paymentCardsRespond(id: string, action: 'save' | 'dismiss'): Promise<{ ok: boolean; pending?: boolean; error?: string }>
  onPaymentCardsStatus(listener: (status: PaymentCardSettingsStatus) => void): () => void
  onPaymentCardSaveRequest(listener: (request: PaymentCardSaveRequest) => void): () => void
  walletStatus(): Promise<WalletStatus>
  walletSnapshot(): Promise<WalletSnapshot>
  walletSettings(): Promise<{ esploraUrl: string; privacyNotice: string }>
  walletSetSettings(config: { esploraUrl: string }): Promise<{ esploraUrl: string; privacyNotice: string }>
  walletPrepareBitcoinSend(address: string, amount: string): Promise<BitcoinSendPreview>
  walletConfirmBitcoinSend(token: string): Promise<{ txid: string }>
  walletLoadMoneroRecord(): Promise<MoneroWalletRecord | null>
  walletSaveMoneroRecord(record: MoneroWalletRecord): Promise<void>
  walletDeleteMoneroRecord(): Promise<void>
  nwcStatus(): Promise<NwcSnapshot>
  nwcConnect(uri: string): Promise<NwcSnapshot>
  nwcDisconnect(): Promise<NwcSnapshot>
  nwcRefresh(): Promise<NwcSnapshot>
  nwcPay(invoice: string): Promise<{ preimage?: string; feesPaidMsat?: string }>
  nwcMakeInvoice(params: { amount: number; description?: string; expiry?: number }): Promise<{ invoice: string; amountMsat: string; description?: string; expiry?: number }>
  nwcLookupInvoice(params: { payment_hash?: string; invoice?: string }): Promise<NwcInvoiceLookup>
  onPasswordStatus(listener: (status: PasswordVaultStatus) => void): () => void
  onPasswordContext(listener: (context: PasswordContext) => void): () => void
  onPasswordSaveRequest(listener: (request: PasswordSaveRequest) => void): () => void
  onPasskeyConfirmation(listener: (request: PasskeyConfirmationRequest) => void): () => void
  onPasskeyConfirmationResolved(listener: (id: string) => void): () => void
  respondToPasskeyConfirmation(id: string, choice: number | null): Promise<boolean>
  onPasswordToast(listener: (toast: PasswordToast) => void): () => void
  extensionsState(): Promise<ExtensionsState>
  extensionsSetDeveloper(value: boolean): Promise<ExtensionsState>
  extensionsInstall(kind: 'folder' | 'zip'): Promise<ExtensionInstallResult>
  extensionsRemove(id: string): Promise<ExtensionsState>
  extensionsSetEnabled(id: string, value: boolean): Promise<ExtensionsState>
  extensionsSetPrivate(id: string, value: boolean): Promise<ExtensionsState>
  extensionsReload(id: string): Promise<ExtensionsState>
  extensionsOpenOptions(id: string): Promise<void>
  extensionsReveal(id: string): Promise<void>
  extensionsAction(id: string, anchor: { top: number; left: number }): Promise<void>
  onExtensions(listener: (state: ExtensionsState) => void): () => void
  automationState(): Promise<AutomationState>
  automationSetEnabled(value: boolean): Promise<AutomationState>
  automationAddAgent(
    name: string
  ): Promise<{ state: AutomationState; command: string | null; error: string | null }>
  automationRemoveAgent(id: string): Promise<AutomationState>
  automationRegenerateIdentity(
    id: string
  ): Promise<{ state: AutomationState; command: string | null; error: string | null }>
  automationRevoke(agentId: string, site: string | null): Promise<AutomationState>
  automationRevokeSign(agentId: string, site: string | null): Promise<AutomationState>
  automationRevealCommand(agentId: string): Promise<string | null>
  automationRefreshProfile(agentId: string): Promise<AutomationState>
  automationCopyCommand(command: string): Promise<boolean>
  onAutomation(listener: (state: AutomationState) => void): () => void
  torStatus(): Promise<TorStatus>
  appInfo(): Promise<AppInfo>
  torTest(): Promise<TorStatus>
  torRestart(): Promise<TorStatus>
  identity(): Promise<IdentityStatus>
  identityList(): Promise<IdentityList>
  identitySelect(id: string): Promise<IdentityStatus>
  identitySetDefault(id: string): Promise<IdentityList>
  identityRemove(id: string): Promise<IdentityStatus>
  shareNostr(comment: string): Promise<{ accepted: number; relays: number; error?: string }>
  importIdentity(secret: string): Promise<IdentityStatus>
  generateIdentity(): Promise<IdentityStatus>
  generateEphemeralIdentity(): Promise<{ status: IdentityStatus; nsec: string }>
  ephemeralIdentitySecret(): Promise<string | null>
  saveEphemeralIdentity(): Promise<IdentityStatus>
  clearEphemeralIdentity(): Promise<IdentityStatus>
  removeIdentity(): Promise<IdentityStatus>
  identityConnectBunker(url: string): Promise<IdentityStatus>
  identityDisconnect(): Promise<IdentityStatus>
  signerPermissions(): Promise<SignerPermission[]>
  revokePermission(origin: string): Promise<SignerPermission[]>
  /** Requests still waiting for an answer, replayed when chrome mounts. */
  pendingSignerRequests(): Promise<SignerRequest[]>
  /** NIP-07 trust for the page at `url`, as the site panel labels it. */
  signerOrigin(url: string): Promise<SignerOriginState | null>
  setSignerTrust(url: string, trusted: boolean): Promise<SignerOriginState | null>
  respondToSigner(id: string, allow: boolean, remember: boolean): Promise<void>
  runCommand(command: CommandId): Promise<void>
  setOverlay(reason: OverlayReason, active: boolean): Promise<void>
  onSignerRequest(listener: (request: SignerRequest) => void): () => void
  onSignerResolved(listener: (id: string) => void): () => void
  onFocusAddress(listener: () => void): () => void
  onOpenSettings(listener: (payload: { section: string }) => void): () => void
  onCloseMenu(listener: () => void): () => void
  onOpenHistory(listener: () => void): () => void
  onOpenDownloads(listener: () => void): () => void
  onBookmarks(listener: (bookmarks: Bookmark[]) => void): () => void
  onState(listener: (state: NavState) => void): () => void
  onConfig(listener: (config: AppConfig) => void): () => void
  onDownload(listener: (notice: DownloadNotice) => void): () => void
}

declare global {
  interface Window {
    ncc: NccApi
  }
}
