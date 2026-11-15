import type { CommandId } from './commands'
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
import type {
  AppearanceConfig,
  AppConfig,
  Bookmark,
  DownloadNotice,
  IdentityStatus,
  NavState,
  OmniboxSuggestion,
  OverlayReason,
  HttpsMode,
  PasswordConfig,
  PasswordContext,
  PasswordCopyResult,
  PasswordDraft,
  PasswordEntry,
  PasswordExportResult,
  PasswordFillResult,
  PasswordGeneratorOptions,
  PasswordImportPreview,
  PasswordSaveRequest,
  PasswordSaveResult,
  PasswordSummary,
  PasswordToast,
  PasswordTotpCode,
  PasswordVaultStatus,
  RelayEntry,
  RelayLocatorOutcome,
  SignerPermission,
  SignerOriginState,
  SignerRequest,
  TabHistory,
  TorMode,
  TorStatus
} from './types'

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
  duplicateTab(id?: string): Promise<void>
  reloadTab(id?: string): Promise<void>
  toggleMute(id?: string): Promise<void>
  closeOtherTabs(id?: string): Promise<void>
  closeTabsToRight(id?: string): Promise<void>
  showTabMenu(id: string): Promise<void>
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
  setPreferTor(value: boolean): Promise<SetRelaysResult>
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
  }): Promise<SetRelaysResult>
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
  }): Promise<SetRelaysResult>
  setAppearance(appearance: Partial<AppearanceConfig>): Promise<SetAppearanceResult>
  passwordsStatus(): Promise<PasswordVaultStatus>
  passwordsContext(): Promise<PasswordContext>
  passwordsUnlock(): Promise<PasswordVaultStatus>
  passwordsLock(): Promise<PasswordVaultStatus>
  passwordsList(): Promise<PasswordSummary[]>
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
  onPasswordStatus(listener: (status: PasswordVaultStatus) => void): () => void
  onPasswordContext(listener: (context: PasswordContext) => void): () => void
  onPasswordSaveRequest(listener: (request: PasswordSaveRequest) => void): () => void
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
  torStatus(): Promise<TorStatus>
  torTest(): Promise<TorStatus>
  torRestart(): Promise<TorStatus>
  identity(): Promise<IdentityStatus>
  importIdentity(secret: string): Promise<IdentityStatus>
  generateIdentity(): Promise<IdentityStatus>
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
