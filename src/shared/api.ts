import type { AppConfig, NavState } from './types'

export interface SetRelaysResult {
  ok: boolean
  config?: AppConfig
  error?: string
}

/**
 * The only surface the chrome renderer gets. Remote content never sees any of it:
 * the content view is a separate, sandboxed WebContents with no preload.
 */
export interface NccApi {
  navigate(input: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  stop(): Promise<void>
  getState(): Promise<NavState>
  getConfig(): Promise<AppConfig>
  setRelays(relays: string[]): Promise<SetRelaysResult>
  onState(listener: (state: NavState) => void): () => void
}

declare global {
  interface Window {
    ncc: NccApi
  }
}
