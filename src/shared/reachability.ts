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
}
