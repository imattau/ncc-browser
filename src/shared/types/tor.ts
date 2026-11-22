import type { TorMode } from './base'

export const DEFAULT_TOR_SOCKS = 'socks5://127.0.0.1:9050'

export interface TorState {
  /** Global preference: use onion endpoints automatically when a locator has one. */
  preferTor: boolean
  /** The current record publishes at least one usable .onion endpoint. */
  onionAvailable: boolean
  /** The current document was fetched from an onion endpoint. */
  active: boolean
  /** The active tab is a full Tor tab (all traffic is proxied). */
  tabTor: boolean
}

export type TorRuntimeKind = 'bundled' | 'local'

export interface TorStatus {
  ready: boolean
  starting: boolean
  proxy: string | null
  kind: TorRuntimeKind | null
  error: string | null
  mode: TorMode
  configured: string
}
