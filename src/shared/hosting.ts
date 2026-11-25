/**
 * Hosted services: the data model and validation shared by the main process, the
 * chrome renderer and the standalone publisher.
 *
 * A service is published as a normal NCC-05 locator (`kind 30058`). The owner's own
 * locator is encrypted to themselves by default; a share is the same payload encrypted
 * to one recipient under a distinct `d` tag, so it can be resolved and revoked without
 * changing the canonical service address.
 */

import { nip19 } from 'nostr-tools'
import { buildNccUrl } from './ncc-url'

export type HostingVisibility = 'private' | 'public'

export interface ServiceEndpoint {
  /** Normalised `http(s)://` URL. A `.onion` host is tagged `family: 'onion'`. */
  url: string
  priority: number
  family?: 'ipv4' | 'ipv6' | 'onion'
  /** base64url(sha256(SPKI)) when the publisher pins TLS. */
  k?: string
  /** Set on an endpoint the browser generated itself, such as a local TLS proxy. */
  source?: 'tls-proxy'
}

export interface HostedService {
  id: string
  /** Canonical `d` tag. Immutable after creation; shares derive from it. */
  service: string
  /** Hex pubkey of the identity that signed the locator, once published. */
  owner?: string
  title: string
  endpoints: ServiceEndpoint[]
  /** Locator lifetime. The locator is refreshed while the browser runs. */
  ttlSeconds: number
  visibility: HostingVisibility
  /** Optional NCC-02 anchor. Only allowed for public services. */
  anchor: boolean
  notes?: string
  createdAt: number
  updatedAt: number
  lastPublishedAt?: number
  lastPublishError?: string
}

export type ShareStatus = 'active' | 'expired' | 'revoked'

export interface ServiceShare {
  id: string
  serviceId: string
  /** `share-<12 hex>`; reserved prefix, never falls back to `addr`. */
  dTag: string
  /** Recipient hex pubkey. The payload is NIP-44 encrypted to this key. */
  recipient: string
  recipientNpub: string
  label?: string
  /** Unix seconds. */
  expiresAt: number
  createdAt: number
  lastPublishedAt?: number
  status: ShareStatus
}

export interface ReceivedShare {
  id: string
  owner: string
  ownerNpub: string
  dTag: string
  title?: string
  /** Unix seconds. */
  expiresAt: number
  firstSeenAt: number
}

export interface HostingState {
  version: 1
  services: HostedService[]
  shares: ServiceShare[]
  received: ReceivedShare[]
  /** Runtime onion endpoints; not persisted with the locator state. */
  onions?: OnionStatus[]
  /** Runtime view of the services the browser secures with HTTPS; not persisted. */
  https?: HttpsPlan[]
}

export interface OnionStatus {
  /** Hosted service id. */
  serviceId: string
  /** `<id>.onion`, without a scheme. */
  host: string
  url: string
  /** Loopback target Tor forwards to, e.g. `127.0.0.1:8080`. */
  target: string
  /** Unix seconds when the last through-Tor check succeeded. */
  verifiedAt?: number
  createdAt: number
  error?: string
}

export interface HostingOnionResult {
  state: HostingState
  onion: OnionStatus
}

/** The browser's HTTPS front for one service's plain HTTP server. */
export interface HttpsFront {
  /** The port the plain HTTP server listens on. */
  targetPort: number
  /** The port the browser serves HTTPS on. */
  listenPort: number
  /** base64url(sha256(SPKI)) of the browser's certificate. */
  pin: string
}

/**
 * How an endpoint host relates to this machine: one of its own addresses, another
 * private address, or an address that reaches it through a router.
 */
export type EndpointHostKind = 'local' | 'private' | 'public'

export interface HttpsPlan {
  serviceId: string
  listenPort: number
  targetPort: number
  /** The addresses that publishing and sharing send. */
  endpoints: ServiceEndpoint[]
  /** Public TCP ports the router has to forward to `listenPort` on this machine. */
  routerPorts: number[]
  /** This machine's LAN address, for the router rule. */
  lanAddress?: string
}

export interface TlsProxyStatus extends HttpsFront {
  serviceId: string
  /** The loopback form of the `https://` address the browser listens on. */
  url: string
  /** base64url(sha256(SPKI)) of the generated certificate; published as the endpoint `k`. */
  pin: string
  /** The `http://` backend the proxy forwards to, as `host:port`. */
  target: string
}

export interface HostingTlsProxyResult {
  state: HostingState
  proxy: TlsProxyStatus
}

export interface CertificateInfo {
  /** base64url(sha256(SPKI)), the value stored as endpoint `k`. */
  pin: string
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  /** DNS names and IP addresses from the subjectAltName extension. */
  names: string[]
}

export interface GeneratedCertificate extends CertificateInfo {
  certPath: string
  keyPath: string
}

/** Whether a certificate's SANs name this host (wildcards included). */
export function certificateCoversHost(info: Pick<CertificateInfo, 'names'>, host: string): boolean {
  const canonical = (value: string): string => {
    const bare = value.trim().replace(/^\[|\]$/g, '')
    if (!bare.includes(':')) return bare.toLowerCase()
    try {
      return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    } catch {
      return bare.toLowerCase()
    }
  }
  const target = canonical(host)
  if (!target) return false
  return info.names.some((name) => {
    const raw = name.trim()
    if (!raw) return false
    if (raw.startsWith('*.')) {
      const suffix = raw.slice(1).toLowerCase()
      return target.endsWith(suffix) && target.split('.').length === raw.split('.').length
    }
    return canonical(raw) === target
  })
}

export interface HostingDraft {
  title: string
  service?: string
  /** Optional until publishing; an address can exist before its transport. */
  endpoints?: Array<string | ServiceEndpoint>
  ttlSeconds?: number
  visibility?: HostingVisibility
  anchor?: boolean
  notes?: string
}

export interface NormalizedHostingDraft {
  title: string
  service: string
  endpoints: ServiceEndpoint[]
  ttlSeconds: number
  visibility: HostingVisibility
  anchor: boolean
  notes?: string
}

export interface NccEventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface HostingPayload {
  v: 1
  ttl: number
  updated_at: number
  endpoints: Array<{ url: string; priority: number; family?: string; k?: string }>
  notes?: string
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

export interface HostingPublishReport {
  ok: boolean
  accepted: number
  relays: number
  errors: Array<{ relay: string; error: string }>
}

export interface HostingPublishResult extends HostingPublishReport {
  serviceId: string
  shares: Array<{ shareId: string; report: HostingPublishReport }>
}

export interface HostingShareResult {
  share: ServiceShare
  address: string
  report: HostingPublishReport
}

export interface HostingShareBatchEntry extends HostingShareResult {
  recipient: string
}

export interface HostingShareBatchResult {
  shares: HostingShareBatchEntry[]
  failures: Array<{ recipient: string; error: string }>
}

export const DEFAULT_HOSTED_TTL_SECONDS = 7 * 86_400
export const MIN_HOSTED_TTL_SECONDS = 3_600
export const MAX_HOSTED_TTL_SECONDS = 30 * 86_400
export const DEFAULT_SHARE_DAYS = 7
export const MIN_SHARE_DAYS = 1
export const MAX_SHARE_DAYS = 30
export const SHARE_PREFIX = 'share-'
export const MAX_SERVICE_ID_LENGTH = 40
export const MAX_TITLE_LENGTH = 80
export const MAX_NOTES_LENGTH = 280

const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const HEX_RE = /^[0-9a-f]{64}$/i

export function emptyHostingState(): HostingState {
  return { version: 1, services: [], shares: [], received: [] }
}

export function isShareService(service: string): boolean {
  return service.startsWith(SHARE_PREFIX)
}

export function isReservedServiceId(service: string): boolean {
  return isShareService(service)
}

export function slugifyService(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SERVICE_ID_LENGTH)
  const fallback = slug || 'service'
  return fallback.startsWith(SHARE_PREFIX) ? `svc-${fallback}`.slice(0, MAX_SERVICE_ID_LENGTH) : fallback
}

export function validateServiceId(input: string): Validation<string> {
  const value = input.trim().toLowerCase()
  if (!value) return { ok: false, error: 'Enter a service name' }
  if (value.length > MAX_SERVICE_ID_LENGTH) {
    return { ok: false, error: `Use at most ${MAX_SERVICE_ID_LENGTH} characters` }
  }
  if (!SERVICE_ID_RE.test(value)) {
    return { ok: false, error: 'Use lowercase letters, digits and single hyphens' }
  }
  if (isReservedServiceId(value)) {
    return { ok: false, error: `Service names starting with "${SHARE_PREFIX}" are reserved for shares` }
  }
  return { ok: true, value }
}

export function parseRecipient(value: string): string | null {
  const text = value.trim()
  if (HEX_RE.test(text)) return text.toLowerCase()
  if (!text.startsWith('npub1')) return null
  try {
    const decoded = nip19.decode(text)
    return decoded.type === 'npub' ? decoded.data : null
  } catch {
    return null
  }
}

export function recipientNpub(hex: string): string {
  return nip19.npubEncode(hex)
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (host === '0.0.0.0') return true
  return /^127\./.test(host)
}

export function isLoopbackEndpoint(endpoint: ServiceEndpoint): boolean {
  try {
    return isLoopbackHost(new URL(endpoint.url).hostname)
  } catch {
    return false
  }
}

function normalizeEndpointUrl(input: string): Validation<{ url: string; family?: ServiceEndpoint['family'] }> {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { ok: false, error: 'Enter a full http:// or https:// URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// endpoints are supported' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not put credentials in an endpoint URL' }
  }
  const host = url.hostname.toLowerCase()
  const family = host.endsWith('.onion')
    ? 'onion'
    : host.includes(':')
      ? 'ipv6'
      : /^\d+\.\d+\.\d+\.\d+$/.test(host)
        ? 'ipv4'
        : undefined
  return { ok: true, value: { url: url.toString(), ...(family ? { family } : {}) } }
}

export function normalizeEndpoint(
  input: string | ServiceEndpoint,
  fallbackPriority = 1000
): Validation<ServiceEndpoint> {
  if (typeof input === 'string') {
    const parsed = normalizeEndpointUrl(input)
    if (!parsed.ok) return parsed
    return {
      ok: true,
      value: { ...parsed.value, priority: fallbackPriority }
    }
  }
  const parsed = normalizeEndpointUrl(input.url)
  if (!parsed.ok) return parsed
  const priority = Number.isFinite(Number(input.priority))
    ? Math.max(0, Math.round(Number(input.priority)))
    : fallbackPriority
  const k = typeof input.k === 'string' ? input.k.trim() : ''
  if (k && !/^[A-Za-z0-9_-]+$/.test(k)) {
    return { ok: false, error: 'The TLS pin must be base64url' }
  }
  return {
    ok: true,
    value: {
      ...parsed.value,
      priority,
      ...(k ? { k } : {}),
      ...(input.source === 'tls-proxy' ? { source: input.source } : {})
    }
  }
}

export function isTlsProxyEndpoint(endpoint: ServiceEndpoint): boolean {
  return endpoint.source === 'tls-proxy'
}

/**
 * The endpoints to publish for a service the browser secures with HTTPS. The saved
 * endpoints stay as the user typed them; every one that reaches the plain HTTP server
 * becomes a pinned `https://` address:
 *
 * - this machine's own addresses use the HTTPS port;
 * - public addresses keep their port, and the router forwards it to the HTTPS port.
 *
 * Onion addresses (already encrypted by Tor), other ports and other machines on the
 * local network are left alone.
 */
export function secureEndpoints(
  endpoints: readonly ServiceEndpoint[],
  front: HttpsFront,
  hostKind: (host: string) => EndpointHostKind
): { endpoints: ServiceEndpoint[]; routerPorts: number[] } {
  const out: ServiceEndpoint[] = []
  const routerPorts = new Set<number>()
  const add = (endpoint: ServiceEndpoint): void => {
    if (!out.some((entry) => entry.url === endpoint.url)) out.push(endpoint)
  }
  for (const endpoint of endpoints) {
    // Saved by v0.47, which published a loopback-only proxy address.
    if (isTlsProxyEndpoint(endpoint)) continue
    const url = new URL(endpoint.url)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host.endsWith('.onion') || endpointPort(url) !== front.targetPort) {
      add({ ...endpoint })
      continue
    }
    const kind = isLoopbackHost(host) ? 'local' : hostKind(host)
    if (kind === 'private') {
      add({ ...endpoint })
      continue
    }
    const port = kind === 'local' ? front.listenPort : front.targetPort
    if (kind === 'public') routerPorts.add(port)
    url.protocol = 'https:'
    // Setting the protocol can drop a default port, so the port is set afterwards.
    url.port = String(port)
    add({ ...endpoint, url: url.toString(), k: front.pin })
  }
  return { endpoints: out, routerPorts: [...routerPorts] }
}

export function endpointPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

export function validateHostingDraft(input: HostingDraft): Validation<NormalizedHostingDraft> {
  const title = input.title.trim()
  if (!title) return { ok: false, error: 'Give the service a name' }
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `Use at most ${MAX_TITLE_LENGTH} characters for the name` }
  }

  const service = validateServiceId(input.service?.trim() || slugifyService(title))
  if (!service.ok) return service

  const rawEndpoints = Array.isArray(input.endpoints) ? input.endpoints : []
  const endpoints: ServiceEndpoint[] = []
  for (const raw of rawEndpoints) {
    const normalized = normalizeEndpoint(raw)
    if (!normalized.ok) return normalized
    if (!endpoints.some((endpoint) => endpoint.url === normalized.value.url)) {
      endpoints.push(normalized.value)
    }
  }
  const visibility: HostingVisibility = input.visibility === 'public' ? 'public' : 'private'
  if (visibility === 'public' && endpoints.some(isLoopbackEndpoint)) {
    return { ok: false, error: 'A public service cannot use a loopback endpoint' }
  }

  const requestedTtl = Number(input.ttlSeconds ?? DEFAULT_HOSTED_TTL_SECONDS)
  const ttlSeconds = Number.isFinite(requestedTtl)
    ? Math.min(MAX_HOSTED_TTL_SECONDS, Math.max(MIN_HOSTED_TTL_SECONDS, Math.round(requestedTtl)))
    : DEFAULT_HOSTED_TTL_SECONDS

  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, MAX_NOTES_LENGTH) : ''

  return {
    ok: true,
    value: {
      title,
      service: service.value,
      endpoints,
      ttlSeconds,
      visibility,
      anchor: input.anchor === true,
      ...(notes ? { notes } : {})
    }
  }
}

/**
 * The share id used up to v0.47.6. Anyone can recompute it from the public service id
 * and a candidate recipient's public key, so it is only used to recognise old links.
 * New shares get a random id.
 */
export function legacyShareDTag(service: string, recipientHex: string): string {
  const input = `${service}:${recipientHex.toLowerCase()}`
  const a = fnv1a(input, 0x811c9dc5)
  const b = fnv1a(input, 0x9e3779b9)
  return `${SHARE_PREFIX}${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0').slice(0, 4)}`
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function shareStatus(share: ServiceShare, now: number): ShareStatus {
  if (share.status === 'revoked') return 'revoked'
  return share.expiresAt <= now ? 'expired' : 'active'
}

export function shareExpiry(days: number, now: number): number {
  const safeDays = Math.min(MAX_SHARE_DAYS, Math.max(MIN_SHARE_DAYS, Math.round(days)))
  return now + safeDays * 86_400
}

export function serviceAddress(npub: string, service: string): string {
  return buildNccUrl({ pubkey: npub, service })
}

export function receivedShareId(owner: string, dTag: string): string {
  return `${owner.toLowerCase()}:${dTag}`
}
