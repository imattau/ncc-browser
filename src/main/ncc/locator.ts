/**
 * Pure NCC-05 payload logic: candidate `d` tags, payload validation, and endpoint
 * normalisation. No I/O, so every rule here is unit-testable.
 */

import { DEFAULT_SERVICE, type EndpointFamily, type ResolvedEndpoint } from '@shared/types'

export const DEFAULT_D_TAG = DEFAULT_SERVICE
export const DEFAULT_PRIORITY = 1000

const FAMILY_ORDER: Record<EndpointFamily, number> = {
  onion: 0,
  ipv6: 1,
  ipv4: 2,
  unknown: 3
}

/** Schemes that can carry a page, plus relay schemes when explicitly allowed. */
const WEB_SCHEME_ALIASES: Record<string, string> = {
  http: 'http',
  https: 'https',
  tcp: 'http',
  tls: 'https',
  tcps: 'https',
  ssl: 'https',
  ws: 'ws',
  wss: 'wss'
}

const RELAY_SCHEMES = new Set(['ws', 'wss'])

export interface NormalizeEndpointOptions {
  /**
   * Accept `ws:`/`wss:` endpoints. Only relay resolution sets this; page navigation
   * must never receive a WebSocket URL.
   */
  allowWs?: boolean
}

/**
 * The `d` tag is not standardised across publishers: NCC-05 defaults to `addr`,
 * `ncc-sidecar` publishes `<service>-locator`, and NCC-02 uses the bare service id.
 * Probe the most specific first and fall back to the generic record last.
 */
export function candidateDTags(service?: string | null): string[] {
  const requested = (service ?? '').trim() || DEFAULT_D_TAG
  if (requested === DEFAULT_D_TAG) return [DEFAULT_D_TAG]
  return [...new Set([requested, `${requested}-locator`, DEFAULT_D_TAG])]
}

export function dTagSource(dTag: string, service: string): 'exact' | 'locator-suffix' | 'default' {
  if (dTag === service) return 'exact'
  if (dTag === `${service}-locator`) return 'locator-suffix'
  return 'default'
}

export interface NccPayload {
  v?: number
  ttl: number
  updated_at: number
  endpoints: unknown[]
  caps?: string[]
  notes?: string
  [key: string]: unknown
}

export function parsePayload(value: unknown): NccPayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  if (!Array.isArray(payload.endpoints)) return null

  const ttl = Number(payload.ttl)
  const updatedAt = Number(payload.updated_at)
  if (!Number.isFinite(ttl) || ttl <= 0) return null
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null

  return { ...payload, ttl, updated_at: updatedAt } as NccPayload
}

/** NCC-05 §8: expiry is the earliest of the `expiration` tag and `updated_at + ttl`. */
export function payloadExpiry(payload: NccPayload, expirationTag?: string | null): number {
  const fromTag = Number(expirationTag)
  const fromTtl = payload.updated_at + payload.ttl
  return Number.isFinite(fromTag) && fromTag > 0 ? Math.min(fromTag, fromTtl) : fromTtl
}

function absoluteUrl(raw: string, declaredProtocol: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  const protocol = /^[a-z][a-z0-9+.-]*$/i.test(declaredProtocol) ? declaredProtocol : 'http'
  return `${protocol}://${raw}`
}

function detectFamily(hostname: string, declared: unknown): EndpointFamily {
  const value = typeof declared === 'string' ? declared.toLowerCase() : ''
  if (value === 'onion' || value === 'ipv6' || value === 'ipv4') return value
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (host.endsWith('.onion')) return 'onion'
  if (host.includes(':')) return 'ipv6'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'ipv4'
  return 'unknown'
}

/**
 * Normalise publisher payload endpoints into fetchable http(s) URLs.
 *
 * Verified quirks this handles:
 * - the spec says `url`, the JS reference implementation publishes `uri`;
 * - `uri` values frequently have no scheme at all (`192.168.1.42:443`);
 * - `priority` is often omitted (spec default 1000, but one helper defaults to 0).
 */
export function normalizeEndpoints(
  input: unknown,
  options: NormalizeEndpointOptions = {}
): ResolvedEndpoint[] {
  if (!Array.isArray(input)) return []

  const out: ResolvedEndpoint[] = []
  const seen = new Set<string>()

  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>

    const rawUrl = String(raw.url ?? raw.uri ?? raw.value ?? '').trim()
    if (!rawUrl) continue

    const declaredProtocol = String(raw.protocol ?? raw.type ?? raw.scheme ?? '').toLowerCase()
    const absolute = absoluteUrl(rawUrl, declaredProtocol)

    let parsed: URL
    try {
      parsed = new URL(absolute)
    } catch {
      continue
    }

    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
    const protocol = WEB_SCHEME_ALIASES[scheme]
    if (!protocol) continue
    if (RELAY_SCHEMES.has(protocol) && options.allowWs !== true) continue

    // Non-special schemes cannot be re-typed in place, so rebuild the URL.
    const host = parsed.host
    if (!host) continue
    let url: URL
    try {
      url = new URL(`${protocol}://${host}${parsed.pathname}${parsed.search}${parsed.hash}`)
    } catch {
      continue
    }

    const href = url.toString()
    if (seen.has(href)) continue
    seen.add(href)

    const fingerprint = raw.k ?? raw.fingerprint
    const priority = Number(raw.priority ?? raw.prio)

    out.push({
      url: href,
      protocol,
      priority: Number.isFinite(priority) ? priority : DEFAULT_PRIORITY,
      family: detectFamily(url.hostname, raw.family),
      k: typeof fingerprint === 'string' && fingerprint.trim() ? fingerprint.trim() : null
    })
  }

  return out
}

export function sortEndpoints(endpoints: ResolvedEndpoint[]): ResolvedEndpoint[] {
  return [...endpoints].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const family = FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]
    if (family !== 0) return family
    return a.url.localeCompare(b.url)
  })
}

/** True when the endpoint's scheme is protected, i.e. pinning is meaningful. */
export function isSecureEndpoint(endpoint: ResolvedEndpoint): boolean {
  return endpoint.protocol === 'https' || endpoint.protocol === 'wss'
}

/** True when the endpoint can carry a Nostr relay connection. */
export function isRelayEndpoint(endpoint: ResolvedEndpoint): boolean {
  return endpoint.protocol === 'ws' || endpoint.protocol === 'wss'
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.endsWith('.localhost')
}

export type RelayEndpointRejection =
  | 'no-relay-endpoint'
  | 'onion-requires-tor'
  | 'insecure-endpoint'
  | null

export interface RelayEndpointSelection {
  endpoint: ResolvedEndpoint | null
  /** Other usable endpoints, in preference order, for failover or display. */
  alternatives: ResolvedEndpoint[]
  /** Why the preferred endpoints were rejected; null when one was chosen. */
  rejected: RelayEndpointRejection
}

/**
 * Choose a relay endpoint from an IPv6/onion/IPv4 mix.
 *
 * Rules, in order:
 * - only `ws:`/`wss:` endpoints qualify;
 * - `ws:` is cleartext, so it is only allowed on loopback or an onion address;
 * - onion endpoints need Tor; without it they are skipped rather than failing;
 * - `wss:` beats `ws:` within the publisher's priority order.
 */
export function selectRelayEndpoint(
  endpoints: readonly ResolvedEndpoint[],
  options: { torReady: boolean }
): RelayEndpointSelection {
  const candidates = endpoints.filter(isRelayEndpoint)
  if (candidates.length === 0) {
    return { endpoint: null, alternatives: [], rejected: 'no-relay-endpoint' }
  }

  const usable = candidates.filter((endpoint) => {
    if (endpoint.family === 'onion' && !options.torReady) return false
    if (endpoint.protocol === 'ws' && endpoint.family !== 'onion' && !isLoopbackHost(new URL(endpoint.url).hostname)) {
      return false
    }
    return true
  })

  const ordered = sortEndpoints(usable).sort(
    (a, b) => Number(b.protocol === 'wss') - Number(a.protocol === 'wss')
  )

  if (ordered.length > 0) {
    return { endpoint: ordered[0], alternatives: ordered.slice(1), rejected: null }
  }

  if (candidates.some((endpoint) => endpoint.family === 'onion')) {
    return { endpoint: null, alternatives: [], rejected: 'onion-requires-tor' }
  }
  return { endpoint: null, alternatives: [], rejected: 'insecure-endpoint' }
}
