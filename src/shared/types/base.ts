/**
 * Primitives shared by every other type module. Kept dependency-free so the domain
 * modules below can import from here without forming a cycle.
 */

/** Content isolation for a tab. */
export type TabKind = 'normal' | 'private' | 'tor'

export type EndpointFamily = 'onion' | 'ipv6' | 'ipv4' | 'unknown'

/** How the transport to the resolved endpoint is protected. */
export type TransportSecurity = 'pinned-tls' | 'tls' | 'plaintext' | 'nsite' | 'unknown'

/** Automatic uses the bundled Tor, then a local SOCKS proxy. Local uses the configured one. */
export type TorMode = 'auto' | 'local'

/** HTTPS policy for clearnet navigation and published NCC endpoints. */
export type HttpsMode = 'off' | 'prefer' | 'only'

export type PageMode = 'blank' | 'ncc' | 'nsite' | 'web' | 'error'
