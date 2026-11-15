import type { CommandId } from './commands'
import type { SearchEngineId } from './search'
import type {
  AppConfig,
  Bookmark,
  DownloadNotice,
  IdentityStatus,
  NavState,
  OmniboxSuggestion,
  OverlayReason,
  HttpsMode,
  RelayEntry,
  RelayLocatorOutcome,
  SignerPermission,
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

/**
 * The only surface the chrome renderer gets. Remote content never sees any of it:
 * each content view is a separate, sandboxed WebContents with no preload.
 */
export interface NccApi {
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
  setSearchConfig(config: {
    engine: SearchEngineId
    custom: string
    useOnionSearch: boolean
  }): Promise<SetRelaysResult>
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
