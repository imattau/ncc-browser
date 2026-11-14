/**
 * Shared types and constants. This module is imported by both the main process and
 * the renderer, so it must not depend on Node or Electron APIs.
 */

export const DEFAULT_SERVICE = 'addr'

export type EndpointFamily = 'onion' | 'ipv6' | 'ipv4' | 'unknown'

/** How the transport to the resolved endpoint is protected. */
export type TransportSecurity = 'pinned-tls' | 'tls' | 'plaintext' | 'unknown'

export interface ResolvedEndpoint {
  /** Absolute http(s) URL, normalised so it can be handed straight to fetch. */
  url: string
  protocol: string
  priority: number
  family: EndpointFamily
  /** SPKI fingerprint from the locator (`k`), if the publisher supplied one. */
  k: string | null
}

export interface ResolvedService {
  /** npub (or hex) exactly as it was addressed. */
  pubkey: string
  hexPubkey: string
  service: string
  /** The `d` tag that actually matched. */
  dTag: string
  dTagSource: 'exact' | 'locator-suffix' | 'default'
  endpoints: ResolvedEndpoint[]
  /** Unix seconds. */
  expiresAt: number
  updatedAt: number
  eventId: string
  encrypted: boolean
}

export type ResolveErrorCode =
  | 'invalid-address'
  | 'no-record'
  | 'expired'
  | 'undecryptable'
  | 'invalid-payload'
  | 'no-endpoint'
  | 'relay-error'
  | 'timeout'

export interface ResolveFailure {
  ok: false
  code: ResolveErrorCode
  message: string
  detail?: string
}

export interface ResolveSuccess {
  ok: true
  record: ResolvedService
}

export type ResolveOutcome = ResolveSuccess | ResolveFailure

export interface SecurityInfo {
  transport: TransportSecurity
  /** Host of the endpoint that served the current document, never the full URL. */
  host: string
  pinned: boolean
}

export type PageMode = 'blank' | 'ncc' | 'web' | 'error'

export interface TabSummary {
  id: string
  title: string
  url: string
  loading: boolean
  /** Data URL for the page icon, fetched in main and never linked to the remote origin. */
  favicon: string | null
  audible: boolean
  muted: boolean
}

export type DownloadState = 'started' | 'completed' | 'failed' | 'cancelled'

export interface DownloadNotice {
  id: string
  filename: string
  state: DownloadState
  path?: string
  /** Bytes written so far. Both byte counts are 0 when the server sends no length. */
  receivedBytes: number
  totalBytes: number
  /** Epoch milliseconds. */
  startedAt: number
}

export interface HistoryEntry {
  index: number
  title: string
  url: string
}

export interface TabHistory {
  entries: HistoryEntry[]
  activeIndex: number
}

export interface Bookmark {
  /** The URL doubles as the identity of a bookmark. */
  url: string
  title: string
  /** Epoch milliseconds. */
  createdAt: number
}

/** Reasons the chrome needs the whole window surface, hiding content views. */
export const OVERLAY_REASONS = ['menu', 'settings', 'downloads', 'history', 'tabs'] as const

export type OverlayReason = (typeof OVERLAY_REASONS)[number]

export interface NavState {
  mode: PageMode
  /** Canonical address shown in the address bar. */
  displayUrl: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  security: SecurityInfo | null
  failure: { code: string; message: string } | null
  tabs: TabSummary[]
  activeTabId: string | null
  windowMaximized: boolean
}

export interface AppConfig {
  relays: string[]
  /** Follow NIP-65 relay hints published by the target identity. */
  gossip: boolean
}

export type IdentitySource = 'none' | 'env' | 'file' | 'session'

export type IdentityMode = 'none' | 'local' | 'nip46'

export interface IdentityStatus {
  configured: boolean
  mode: IdentityMode
  npub?: string
  hexPubkey?: string
  source: IdentitySource
  /** True when the key (or NIP-46 session) is encrypted at rest with the OS keychain. */
  persisted: boolean
  /** False when the OS offers no secure storage; the key then lives for this session. */
  encryptionAvailable: boolean
  /** NIP-46 relays, when mode is `nip46`. */
  relays?: string[]
  /** NIP-46 connection acknowledged by the remote signer. */
  connected?: boolean
}

export interface SignerPermission {
  /** `ncc://<npub>` or a web origin. */
  origin: string
  label: string
  trusted: boolean
  /** Epoch milliseconds. */
  createdAt: number
  lastUsedAt: number
}

export interface SignerRequest {
  id: string
  method: string
  /** Short imperative phrase, e.g. "sign a kind 1 event". */
  action: string
  /** `ncc://<npub>/<service>` or a web origin. */
  service: string
  origin: string
  identity: string | null
  mode: IdentityMode
  /** Present for `signEvent`. */
  event?: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }
  /** Extra context for encryption/decryption requests. */
  note?: string
  rememberable: boolean
}

export interface SignerDecision {
  allow: boolean
  remember: boolean
}

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net'
]

/** Human-readable one-liners used by the error page and the renderer. */
export const ERROR_COPY: Record<string, { title: string; hint: string }> = {
  'invalid-address': {
    title: 'Not an NCC address',
    hint: 'An NCC address looks like ncc://npub1…/service. The npub is the trust anchor, so it cannot be omitted.'
  },
  'no-record': {
    title: 'No locator published',
    hint: 'The npub is valid, but no fresh NCC-05 (kind 30058) record was found on the configured relays. Check that the publisher is online and pointed at these relays.'
  },
  expired: {
    title: 'Locator expired',
    hint: 'A record exists but its TTL has passed. NCC-05 forbids using expired locators, so the publisher needs to refresh it.'
  },
  undecryptable: {
    title: 'Locator is private',
    hint: 'This record is encrypted and you are not one of its recipients. Ask the publisher to add your npub, or use a public locator.'
  },
  'invalid-payload': {
    title: 'Malformed locator',
    hint: 'The record was signed correctly but its payload is not valid NCC-05 JSON, or contains no usable endpoints.'
  },
  'no-endpoint': {
    title: 'No usable endpoint',
    hint: 'The locator lists endpoints, but none can be used by this browser (for example only ws:// or .onion transports).'
  },
  'relay-error': {
    title: 'Relay query failed',
    hint: 'The configured relays could not be reached. Check your connection and relay list.'
  },
  timeout: {
    title: 'Resolution timed out',
    hint: 'The relays did not answer in time. This is often a slow or unreachable relay.'
  },
  'endpoint-unreachable': {
    title: 'Endpoint unreachable',
    hint: 'The locator is valid, but the service did not accept a connection. The publisher may be offline or behind a firewall.'
  },
  'k-mismatch': {
    title: 'Transport identity mismatch',
    hint: 'The TLS certificate presented by the endpoint does not match the fingerprint signed into the locator. The connection was refused.'
  },
  'certificate-expired': {
    title: 'Transport certificate expired',
    hint: 'The endpoint presented a certificate that is no longer valid. The locator pins a transport identity; an expired certificate cannot satisfy it.'
  }
}
