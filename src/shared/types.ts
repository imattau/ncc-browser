/**
 * Shared types and constants. This module is imported by both the main process and
 * the renderer, so it must not depend on Node or Electron APIs.
 */

export const DEFAULT_SERVICE = 'addr'

export type EndpointFamily = 'onion' | 'ipv6' | 'ipv4' | 'unknown'

/** How the transport to the resolved endpoint is protected. */
export type TransportSecurity = 'pinned-tls' | 'tls' | 'plaintext' | 'unknown'

/** Automatic uses the bundled Tor, then a local SOCKS proxy. Local uses the configured one. */
export type TorMode = 'auto' | 'local'

export const DEFAULT_TOR_SOCKS = 'socks5://127.0.0.1:9050'

export interface TorState {
  /** Global preference: use onion endpoints automatically when a locator has one. */
  preferTor: boolean
  /** The current record publishes at least one usable .onion endpoint. */
  onionAvailable: boolean
  /** The current document was fetched from an onion endpoint. */
  active: boolean
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

export interface ResolvedEndpoint {
  /** Absolute http(s) URL, normalised so it can be handed straight to fetch. */
  url: string
  protocol: string
  priority: number
  family: EndpointFamily
  /** SPKI fingerprint from the locator (`k`), if the publisher supplied one. */
  k: string | null
  /** Which document supplied the fingerprint that is actually pinned. */
  kSource?: 'ncc-02' | 'ncc-05' | null
}

export interface ServiceAnchor {
  eventId: string
  dTag: string
  /** Fetchable http(s) `u` endpoint, when the record publishes one. */
  endpoint: string | null
  /** The raw `u` value, including non-web schemes such as `wss://` or `onion://`. */
  rawEndpoint: string | null
  k: string | null
  /** Unix seconds; 0 means the record carries no `exp` tag. */
  expiresAt: number
  updatedAt: number
}

export type AnchorStatus =
  | 'anchored'
  | 'unanchored'
  | 'expired'
  | 'invalid'
  | 'required-missing'

export type AnchorKeyMatch =
  | 'match'
  | 'mismatch'
  | 'anchor-only'
  | 'locator-only'
  | 'none'

export interface AnchorInfo {
  status: AnchorStatus
  record: ServiceAnchor | null
  /** True when the page is being served from the NCC-02 `u` fallback. */
  fallback: boolean
  /** How the NCC-02 and NCC-05 transport fingerprints relate. */
  kMatch: AnchorKeyMatch
  /** Whether the user requires NCC-02 anchoring. */
  required: boolean
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
  /** NCC-02 trust anchor, when one was found. */
  anchor?: AnchorInfo
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
  | 'no-anchor'
  | 'anchor-expired'
  | 'anchor-invalid'
  | 'anchor-k-mismatch'

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
  /** True when the document was fetched from an onion endpoint through Tor. */
  viaTor: boolean
  /** NCC-02 trust anchor attached to the locator that served this page. */
  anchor: AnchorInfo | null
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
export const OVERLAY_REASONS = [
  'menu',
  'settings',
  'downloads',
  'history',
  'tabs',
  'site-info'
] as const

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
  tor: TorState
  tabs: TabSummary[]
  activeTabId: string | null
  windowMaximized: boolean
}

export interface AppConfig {
  relays: string[]
  /** Follow NIP-65 relay hints published by the target identity. */
  gossip: boolean
  /** Refuse services that have no fresh NCC-02 service record (kind 30059). */
  anchorRequired: boolean
  /** Automatically use an onion endpoint when the locator publishes one. */
  preferTor: boolean
  /** Automatic prefers the bundled Tor, then a local proxy. */
  torMode: TorMode
  /** Explicit SOCKS proxy used in local mode or when NCC_TOR_SOCKS is unset. */
  torSocks: string
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
    hint: 'The locator lists endpoints, but none can be used by this browser (for example only ws:// transports).'
  },
  'onion-only': {
    title: 'Onion endpoint only',
    hint: 'This locator publishes only an onion endpoint. Turn on "Prefer Tor connections" in settings, or use the onion button in the address bar.'
  },
  'tor-unavailable': {
    title: 'Tor is not available',
    hint: 'NCC found an onion endpoint, but the browser could not start or reach Tor. Check the Tor proxy in settings, or make sure the bundled Tor binary is installed.'
  },
  'tor-clearnet-redirect': {
    title: 'Tor blocked a clearnet redirect',
    hint: 'The onion service tried to redirect this page to the clearnet. The redirect was blocked so the request could not reveal your IP. Load the page without Tor if you trust the destination.'
  },
  'tor-blocked-resource': {
    title: 'Tor blocked a clearnet resource',
    hint: 'A page loaded over Tor requested an NCC resource whose locator has no onion endpoint. The request was blocked so it could not reveal your IP.'
  },
  'relay-error': {
    title: 'Relay query failed',
    hint: 'The configured relays could not be reached. Check your connection and relay list.'
  },
  timeout: {
    title: 'Resolution timed out',
    hint: 'The relays did not answer in time. This is often a slow or unreachable relay.'
  },
  'no-anchor': {
    title: 'No NCC-02 service record',
    hint: 'Anchored mode is on, so this service must publish a fresh kind 30059 service record. Publish one from the NCC publisher, or turn off "Require NCC-02 service records" in settings.'
  },
  'anchor-expired': {
    title: 'NCC-02 service record expired',
    hint: 'The service record exists but its exp tag has passed. Anchored mode fails closed until the publisher refreshes it.'
  },
  'anchor-invalid': {
    title: 'NCC-02 service record is invalid',
    hint: 'The kind 30059 event is missing a valid d tag, has an invalid exp tag, or failed signature verification.'
  },
  'anchor-k-mismatch': {
    title: 'Transport key conflicts with NCC-02',
    hint: 'The NCC-02 service record and the NCC-05 locator advertise different transport fingerprints for the same endpoint. The browser refused the endpoint.'
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
