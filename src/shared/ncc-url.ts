/**
 * Parser and builders for the `ncc://` address scheme.
 *
 * Two forms exist:
 *
 *   display / input   ncc://<npub>/<service>/<path…>     what the user types and sees
 *   internal          ncc://<npub>.<service>/<path…>     what the WebContents loads
 *
 * The internal form puts the service in the host so it is part of the **origin**.
 * That is what makes absolute-path subresources unambiguous (`/assets/app.js` belongs
 * to the service in the origin) and gives each service its own storage, cookies and
 * service-worker scope. `npub` alone is never a document origin: it is the input form
 * and is redirected.
 */

import { base32Decode, base32Encode } from './base32'
import { DEFAULT_SERVICE } from './types'

const NPUB_RE = /^npub1[02-9ac-hj-np-z]{20,}$/
const HEX_RE = /^[0-9a-f]{64}$/
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

/** Service ids that can be used verbatim as a hostname label. */
const HOST_SAFE_SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const ENCODED_PREFIX = 'x-'
const MAX_LABEL = 180

export class NccUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NccUrlError'
  }
}

export interface NccAddress {
  pubkey: string
  service: string
  /** Either empty, `/`, or a path beginning with `/` and preserving a trailing slash. */
  path: string
  search: string
  hash: string
  /** True when the URL already used the host-based internal form. */
  internal: boolean
}

export function isNostrId(value: string): boolean {
  const v = value.toLowerCase()
  return NPUB_RE.test(v) || HEX_RE.test(v)
}

export function isValidServiceName(value: string): boolean {
  return SERVICE_RE.test(value)
}

/** True for things the address bar should treat as NCC addresses. */
export function looksLikeNccInput(input: string): boolean {
  const text = input.trim()
  if (/^ncc:/i.test(text)) return true
  if (/^npub1/i.test(text)) return true
  return /^[0-9a-f]{64}(\/|$)/i.test(text)
}

/**
 * Host label for a service. Host-safe ids are used verbatim so the origin stays
 * readable (`ncc://<npub>.ditto`); everything else is base32 under an `x-` prefix,
 * which is reversible and stable, so origins survive restarts.
 */
export function encodeServiceLabel(service: string): string | null {
  if (HOST_SAFE_SERVICE_RE.test(service) && !service.startsWith(ENCODED_PREFIX)) {
    return service
  }
  const label = `${ENCODED_PREFIX}${base32Encode(service)}`
  return label.length <= MAX_LABEL ? label : null
}

export function decodeServiceLabel(label: string): string | null {
  if (!label.startsWith(ENCODED_PREFIX)) {
    return HOST_SAFE_SERVICE_RE.test(label) ? label : null
  }
  const decoded = base32Decode(label.slice(ENCODED_PREFIX.length))
  if (!decoded || !isValidServiceName(decoded)) return null
  return decoded
}

export interface NccHost {
  pubkey: string
  /** Null for the display/input form (`ncc://<npub>/…`). */
  service: string | null
}

export function parseNccHost(hostname: string): NccHost | null {
  const host = hostname.toLowerCase()
  const dot = host.indexOf('.')
  if (dot === -1) return isNostrId(host) ? { pubkey: host, service: null } : null

  const pubkey = host.slice(0, dot)
  if (!isNostrId(pubkey)) return null
  const service = decodeServiceLabel(host.slice(dot + 1))
  return service ? { pubkey, service } : null
}

export function parseNccAddress(raw: string): NccAddress {
  const original = raw.trim()
  if (!original) throw new NccUrlError('Enter an address')

  let input = original
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^ncc:\/\//i.test(input)) {
    throw new NccUrlError('Only ncc:// addresses are supported here')
  }
  if (/^ncc:/i.test(input) && !/^ncc:\/\//i.test(input)) {
    // ncc:npub1…/service → ncc://npub1…/service
    input = `ncc://${input.slice(4).replace(/^\/+/, '')}`
  } else if (!/^ncc:\/\//i.test(input)) {
    // npub1…/service → ncc://npub1…/service
    input = `ncc://${input.replace(/^\/+/, '')}`
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new NccUrlError('That is not a valid URL')
  }

  if (url.protocol !== 'ncc:') throw new NccUrlError('Only ncc:// addresses are supported here')

  const host = parseNccHost(url.hostname)
  if (!host) {
    throw new NccUrlError(
      'The host must be an npub (npub1…) or a 64-character hex pubkey, optionally followed by a service'
    )
  }
  if (!host.pubkey) throw new NccUrlError('Missing npub: use ncc://<npub>/<service>')

  if (host.service) {
    return {
      pubkey: host.pubkey,
      service: host.service,
      path: url.pathname || '/',
      search: url.search,
      hash: url.hash,
      internal: true
    }
  }

  const pathname = url.pathname
  let withoutLeading = pathname.replace(/^\/+/, '')
  // Internal/self-referential URLs may carry the explicit service prefix.
  if (withoutLeading.startsWith('_/')) withoutLeading = withoutLeading.slice(2)
  const slash = withoutLeading.indexOf('/')
  const rawService = slash === -1 ? withoutLeading : withoutLeading.slice(0, slash)
  const rest = slash === -1 ? '' : withoutLeading.slice(slash + 1)

  let service = DEFAULT_SERVICE
  if (rawService) {
    try {
      service = decodeURIComponent(rawService)
    } catch {
      throw new NccUrlError('That service name is not valid')
    }
    if (!isValidServiceName(service)) {
      throw new NccUrlError(`"${service}" is not a valid service name`)
    }
  }

  let path = ''
  if (rest) path = `/${rest}`
  else if (pathname.endsWith('/')) path = '/'

  return {
    pubkey: host.pubkey,
    service,
    path,
    search: url.search,
    hash: url.hash,
    internal: false
  }
}

export interface BuildAddress {
  pubkey: string
  service?: string
  path?: string
  search?: string
  hash?: string
  /** Always end the URL with a slash so relative subresources stay in the service namespace. */
  trailingSlash?: boolean
}

/** Clean, user-facing form. The default service is omitted. */
export function buildNccUrl(address: BuildAddress): string {
  const service = address.service && address.service !== DEFAULT_SERVICE ? address.service : ''
  let path = address.path ?? ''
  if (path && !path.startsWith('/')) path = `/${path}`
  if (path === '/') path = ''

  let base = `ncc://${address.pubkey}`
  if (service) base += `/${service}`
  if (!path && address.trailingSlash !== false) base += '/'

  return `${base}${path}${address.search ?? ''}${address.hash ?? ''}`
}

/** The address to hand to `loadURL`. */
export function toLoadUrl(address: NccAddress): string {
  return toInternalUrl(address)
}

/**
 * Internal, origin-scoped form: `ncc://<npub>.<service>/<path>`.
 *
 * Every navigation the shell initiates uses this form, so the service is part of the
 * origin and absolute-path subresources cannot be attributed to the wrong one. The
 * address bar renders the clean form instead.
 */
export function toInternalUrl(address: NccAddress | BuildAddress): string {
  return buildInternalUrl(address)
}

export function buildInternalUrl(address: BuildAddress): string {
  const service = address.service || DEFAULT_SERVICE
  const label = encodeServiceLabel(service)
  if (!label) throw new NccUrlError(`"${service}" is too long to address over ncc://`)
  let path = address.path ?? '/'
  if (!path.startsWith('/')) path = `/${path}`
  return `ncc://${address.pubkey}.${label}${path}${address.search ?? ''}${address.hash ?? ''}`
}

/** The storage origin for a service: `ncc://<npub>.<label>`. */
export function nccStorageOrigin(pubkey: string, service: string): string {
  const label = encodeServiceLabel(service)
  return label ? `ncc://${pubkey}.${label}` : `ncc://${pubkey}`
}

/** Turn an internal (host) URL into the clean form shown to the user. */
export function toDisplayUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.protocol !== 'ncc:') return url

  const host = parseNccHost(parsed.hostname)
  if (!host?.service) return url

  const servicePart = host.service === DEFAULT_SERVICE ? '' : `/${host.service}`
  return `ncc://${host.pubkey}${servicePart}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** Strip the scheme so the toolbar can show a compact address. */
export function displayAddress(url: string): string {
  return url.replace(/^ncc:\/\//, '')
}
