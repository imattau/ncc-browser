import type {
  AppConfig,
  DownloadNotice,
  IdentityStatus,
  NavState,
  SignerPermission
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
  stop(): Promise<void>
  newTab(input?: string): Promise<string>
  closeTab(id?: string): Promise<void>
  selectTab(id: string): Promise<void>
  getState(): Promise<NavState>
  getConfig(): Promise<AppConfig>
  setRelays(relays: string[]): Promise<SetRelaysResult>
  setGossip(value: boolean): Promise<SetRelaysResult>
  identity(): Promise<IdentityStatus>
  importIdentity(secret: string): Promise<IdentityStatus>
  generateIdentity(): Promise<IdentityStatus>
  removeIdentity(): Promise<IdentityStatus>
  identityConnectBunker(url: string): Promise<IdentityStatus>
  identityDisconnect(): Promise<IdentityStatus>
  signerPermissions(): Promise<SignerPermission[]>
  revokePermission(origin: string): Promise<SignerPermission[]>
  onState(listener: (state: NavState) => void): () => void
  onDownload(listener: (notice: DownloadNotice) => void): () => void
}

declare global {
  interface Window {
    ncc: NccApi
  }
}
