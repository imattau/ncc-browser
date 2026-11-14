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
}

export interface AppConfig {
  relays: string[]
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
  }
}
