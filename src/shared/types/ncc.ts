/**
 * NCC addressing: service locators (NCC-05), NCC-02 trust anchors, resolution outcomes
 * and the transport security attached to a fetched document. Also the user-facing copy
 * for every resolution failure.
 */

import type { EndpointFamily, TransportSecurity } from './base'

export const DEFAULT_SERVICE = 'addr'

/**
 * Metadata for a relay entry that was resolved from an NCC-05 service locator
 * (`ncc://<npub>/<service>`). Kept so the entry can be re-resolved before it goes
 * stale, and so the locator's `k` can be enforced as a TLS pin.
 */
export interface RelayLocatorRef {
  /** Identity exactly as the user entered it (npub or hex). */
  identity: string
  /** Hex pubkey of the identity that published the locator. */
  pubkey: string
  service: string
  /** The `d` tag that matched. */
  dTag: string
  /** Unix seconds after which the locator must be re-resolved. */
  expiresAt: number
  /** Unix seconds after which the NCC-02 service record must be revalidated, when set. */
  serviceExpiresAt?: number
  /** SPKI fingerprint from the endpoint, enforced on `wss:` connections. */
  k: string | null
}

export interface RelayEntry {
  /** Resolved `ws(s)://` endpoint. */
  url: string
  /** Present when the entry came from an NCC-05 locator rather than a fixed URL. */
  locator?: RelayLocatorRef
  /** The last re-resolution failed; the entry keeps working at its previous address. */
  stale?: boolean
}

export type RelayLocatorErrorCode =
  | ResolveErrorCode
  | 'onion-requires-tor'
  | 'insecure-endpoint'

export interface RelayLocatorFailure {
  ok: false
  code: RelayLocatorErrorCode
  error: string
}

export interface RelayLocatorSuccess {
  ok: true
  entry: RelayEntry
}

export type RelayLocatorOutcome = RelayLocatorSuccess | RelayLocatorFailure

export interface ResolvedEndpoint {
  /** Absolute http(s) or ws(s) URL, normalised so it can be handed straight to fetch. */
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
  /** Served from the cached copy; relays have not confirmed it yet. */
  stale?: boolean
  /** NCC-02 trust anchor, when one was found. */
  anchor?: AnchorInfo
  /** Optional publisher note from the decrypted payload. */
  notes?: string
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
  /** True when the selected endpoint is an onion endpoint (regardless of transport). */
  onion: boolean
  /** NCC-02 trust anchor attached to the locator that served this page. */
  anchor: AnchorInfo | null
  /** The NCC-05 record that produced the endpoint, for the site panel. */
  locator: LocatorInfo | null
  /** NIP-5A manifest that produced this page, when the page came from nsite://. */
  manifest?: NsiteInfo | null
}

/** What the site panel shows for a page served from a NIP-5A manifest. */
export interface NsiteInfo {
  /** Named site id, or null for the author's root site. */
  site: string | null
  title: string | null
  description: string | null
  source: string | null
  eventId: string
  updatedAt: number
  aggregate: string | null
  servers: string[]
  files: number
}

/** How old the record behind the current page is, and where it came from. */
export interface LocatorInfo {
  eventId: string
  /** The `d` tag that matched, which may differ from the requested service. */
  dTag: string
  /** Unix seconds when the publisher last refreshed the payload. */
  updatedAt: number
  /** Unix seconds after which the record may not be used. */
  expiresAt: number
  /** Served from the cached copy; relays have not confirmed it yet. */
  stale: boolean
  /** Synthesised from the NCC-02 `u` endpoint because no NCC-05 record was usable. */
  fallback: boolean
  /** The payload was NIP-44 encrypted; the recipient must hold the right identity. */
  encrypted: boolean
  /** The publisher's optional note, decrypted with the payload. */
  notes?: string
}

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
  'no-manifest': {
    title: 'No site published',
    hint: 'No NIP-5A manifest was found for this npub on the configured relays. For a named site, check the site id; for a root site, look for a kind 15128 event.'
  },
  'manifest-invalid': {
    title: 'Malformed site manifest',
    hint: 'The manifest was signed by the right key, but it has no usable path entries or contains an invalid hash.'
  },
  'no-file': {
    title: 'File not in this site',
    hint: 'The manifest does not list this path, and no /404.html was published. Static sites only serve the files in their manifest.'
  },
  'blob-unavailable': {
    title: 'File unavailable',
    hint: 'The manifest lists this file, but no Blossom server returned it. The author needs to republish the blob, or add a server hint.'
  },
  'hash-mismatch': {
    title: 'File failed verification',
    hint: 'A Blossom server returned bytes that do not match the sha256 in the signed manifest. The file was discarded.'
  },
  'too-large': {
    title: 'File is too large',
    hint: 'The file exceeds the 25 MB limit for hash-verified downloads. Large media is not supported yet.'
  },
  expired: {
    title: 'Locator expired',
    hint: 'A record exists but its TTL has passed. NCC-05 forbids using expired locators, so the publisher needs to refresh it.'
  },
  undecryptable: {
    title: 'Locator is encrypted',
    hint: 'This record is addressed to a specific identity. Connect the identity it was shared with in Settings → Identity & signer, then reload. If it was shared with you, ask the owner to confirm your npub.'
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
    hint: 'This locator publishes only an onion endpoint. Turn on "Prefer Tor connections" in settings, or use the onion button in the address bar to open it in a Tor tab.'
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
  'insecure-blocked': {
    title: 'Insecure connection blocked',
    hint: 'HTTPS-only is enabled and this resource would use plaintext HTTP. Load the page and choose to allow HTTP if you trust the destination.'
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
  'tls-failed': {
    title: 'HTTPS connection failed',
    hint: 'The address did not complete an HTTPS connection. The server behind it may only speak plain HTTP. The publisher can turn on HTTPS for the service in this browser, then publish again.'
  },
  'k-mismatch': {
    title: 'Transport identity mismatch',
    hint: 'The TLS certificate presented by the endpoint does not match the fingerprint signed into the locator. The connection was refused.'
  },
  'certificate-expired': {
    title: 'Transport certificate expired',
    hint: 'The endpoint presented a certificate that is no longer valid. The locator pins a transport identity; an expired certificate cannot satisfy it.'
  },
  'certificate-date-invalid': {
    title: 'Certificate date is invalid',
    hint: 'The certificate is outside its valid date range. Check this device’s date and time; if those are correct, the site owner may need to renew the certificate.'
  },
  'certificate-untrusted': {
    title: 'Certificate authority is not trusted',
    hint: 'The browser could not verify who issued this certificate. The connection was blocked.'
  },
  'certificate-name-mismatch': {
    title: 'Certificate is for a different site',
    hint: 'The certificate does not identify this website. Check the address or contact the site owner.'
  },
  'certificate-revoked': {
    title: 'Certificate has been revoked',
    hint: 'The certificate issuer has withdrawn this certificate. The connection was blocked.'
  },
  'certificate-invalid': {
    title: 'Certificate is invalid',
    hint: 'The browser could not verify this website’s certificate, so it blocked the connection.'
  }
}
