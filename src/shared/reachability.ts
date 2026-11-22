/**
 * Service reachability candidates and router classification.
 *
 * The `ncc://` address never changes; these candidates are endpoints the publisher
 * may choose to advertise. Nothing here contacts an external service by itself.
 */

export type EndpointKind =
  | 'loopback'
  | 'lan'
  | 'ipv6'
  | 'public-v4'
  | 'onion'
  | 'current-https'

export type EndpointConfidence =
  | 'owner-only'
  | 'same-network'
  | 'firewall-dependent'
  | 'mapped'
  | 'verified'
  | 'unverified'

export interface EndpointCandidate {
  kind: EndpointKind
  url: string
  family?: 'ipv4' | 'ipv6' | 'onion'
  /** Base64url SPKI fingerprint for an HTTPS endpoint. */
  k?: string
  confidence: EndpointConfidence
  source: 'interface' | 'gateway' | 'external' | 'tor' | 'page'
  note?: string
}

export type WanClass = 'public' | 'private' | 'cgnat' | 'loopback' | 'link-local' | 'unknown'

/**
 * Accept the forms a publisher actually types: `https://host:port`, `host:port`,
 * a bare IPv4 or a bare IPv6 address. A bare address has no TLS pin, so it defaults
 * to http. An explicit https URL keeps https (which is what a `k`-pinned endpoint is).
 */
export function normalizeEndpointSeed(
  input: string,
  fallbackScheme: 'http' | 'https' = 'http'
): string | null {
  const value = input.trim()
  if (!value) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
    } catch {
      return null
    }
  }
  let candidate = value
  if (!candidate.startsWith('[') && (candidate.match(/:/g)?.length ?? 0) > 1) {
    candidate = `[${candidate}]`
  }
  try {
    const url = new URL(`${fallbackScheme}://${candidate}`)
    return url.hostname ? url.toString() : null
  } catch {
    return null
  }
}

export interface GatewayReport {
  wanAddress?: string
  wanClass: WanClass
  upnp: boolean
  natPmp: boolean
  pcp: boolean
  mappingAvailable: boolean
  error?: string
}

export type ExternalCheckState =
  | 'not-run'
  | 'declined'
  | 'confirmed'
  | 'matched'
  | 'mismatch'
  | 'error'

export interface ReachabilityReport {
  seed: string
  candidates: EndpointCandidate[]
  gateway: GatewayReport
  externalCheck: ExternalCheckState
  externalAddress?: string
  /** Disclosed provider used for the public address check. */
  externalProvider?: string
  /** Whether the bundled/external Tor was ready when discovery ran. */
  torReady?: boolean
  warnings: string[]
}

export interface PublicAddressResult {
  address: string
  family: 'ipv4' | 'ipv6'
  provider: string
  checkedAt: number
}

export interface NetworkChange {
  at: number
  interface: string
  family: 'ipv4' | 'ipv6'
  from: string
  to: string
}

/** A router port mapping created for a local service endpoint. */
export interface PortMapping {
  localPort: number
  externalPort: number
  protocol: 'TCP'
  /** Which local router protocol created it. */
  method: 'upnp' | 'natpmp'
  internalClient: string
  externalAddress: string
  url: string
  description?: string
  createdAt: number
  /** Unix seconds when an external check proved the port reachable. */
  verifiedAt?: number
  /** Unix seconds of the most recent check, successful or not. */
  lastCheckedAt?: number
  lastOkAt?: number
  /** Consecutive failed checks since the last success. */
  failures?: number
}

export interface PortStatusEvent {
  mapping: PortMapping
  state: 'ok' | 'failing'
}
