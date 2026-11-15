/**
 * Parser and builders for the `ncc://` address scheme.
 *
 * Canonical form:  ncc://<npub>/<service>/<path…>?<query>
 * The service segment is omitted when it is the default (`addr`).
 */

import { DEFAULT_SERVICE } from './types'

const NPUB_RE = /^npub1[02-9ac-hj-np-z]{20,}$/
const HEX_RE = /^[0-9a-f]{64}$/
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

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

  // Custom-scheme hosts are not lowercased by the URL parser, so normalise here.
  const pubkey = url.hostname.toLowerCase()
  if (!pubkey) throw new NccUrlError('Missing npub: use ncc://<npub>/<service>')
  if (!isNostrId(pubkey)) {
    throw new NccUrlError('The host must be an npub (npub1…) or a 64-character hex pubkey')
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
    pubkey,
    service,
    path,
    search: url.search,
    hash: url.hash
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

/** The address to hand to `loadURL`: service roots always end in a slash so that a
 * page's relative links (`docs/x`) resolve inside the service instead of above it.
 */
export function toLoadUrl(address: NccAddress): string {
  const isRoot = address.path === '' || address.path === '/'
  return buildNccUrl({
    ...address,
    path: isRoot ? '' : address.path,
    trailingSlash: isRoot
  })
}

/**
 * Internal, unambiguous origin form: `ncc://<npub>/_/<service>/<path>`.
 *
 * Every navigation the shell initiates uses this form, so a service can never be
 * confused with a path segment. The address bar renders the clean form instead.
 */
export function toInternalUrl(address: NccAddress): string {
  return buildInternalUrl(address)
}

export function buildInternalUrl(address: BuildAddress): string {
  const service = address.service || DEFAULT_SERVICE
  let path = address.path ?? '/'
  if (!path.startsWith('/')) path = `/${path}`
  return `ncc://${address.pubkey}/_/${service}${path}${address.search ?? ''}${address.hash ?? ''}`
}

/** Turn an internal URL into the clean form shown to the user. */
export function toDisplayUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.protocol !== 'ncc:') return url

  const raw = parsed.pathname.replace(/^\/+/, '')
  if (!(raw === '_' || raw.startsWith('_/'))) return url

  const rest = raw === '_' ? '' : raw.slice(2)
  const slash = rest.indexOf('/')
  const service = slash === -1 ? rest : rest.slice(0, slash)
  const tail = slash === -1 ? '' : rest.slice(slash + 1)
  if (!service) return url

  const servicePart = service === DEFAULT_SERVICE ? '' : `/${service}`
  const path = tail ? `/${tail}` : '/'
  return `ncc://${parsed.hostname}${servicePart}${path}${parsed.search}${parsed.hash}`
}

/**
 * Route an inbound protocol request to a service and a pass-through path.
 *
 * The order matters: an explicit `/_/<service>/…` wins, then the service of the
 * referring page (which is how absolute-path subresources of a background tab are
 * attributed correctly), then the active service for that pubkey, and only then the
 * first path segment.
 */
export function routeNccPath(
  pathname: string,
  activeService: string | null,
  refererService: string | null = null,
  isDocumentRequest = false
): { service: string; path: string } | null {
  const raw = pathname.replace(/^\/+/, '')

  // Explicit form: /_/<service>/<path>
  if (raw === '_' || raw.startsWith('_/')) {
    const rest = raw === '_' ? '' : raw.slice(2)
    const slash = rest.indexOf('/')
    const service = slash === -1 ? rest : rest.slice(0, slash)
    const tail = slash === -1 ? '' : rest.slice(slash + 1)
    if (!service) return null
    if (!isValidServiceName(service)) return null
    return { service, path: tail ? `/${tail}` : '/' }
  }

  // A new document navigation names its own service in the URL. The referer
  // namespace is only a hint for absolute-path subresources such as /assets/app.js;
  // allowing it to win for a document makes a link to /npanel/ from Ditto load Ditto.
  if (!isDocumentRequest && refererService) {
    return { service: refererService, path: pathname || '/' }
  }

  if (!isDocumentRequest && activeService) {
    return { service: activeService, path: pathname || '/' }
  }

  const slash = raw.indexOf('/')
  const service = slash === -1 ? raw : raw.slice(0, slash)
  const tail = slash === -1 ? '' : raw.slice(slash + 1)
  if (!service) return { service: DEFAULT_SERVICE, path: pathname || '/' }
  if (!isValidServiceName(service)) return null
  return { service, path: tail ? `/${tail}` : '/' }
}

/**
 * Derive the service namespace from a same-origin referer. This is what makes
 * absolute-path subresources unambiguous when several tabs share an npub.
 */
export function serviceFromReferer(
  referer: string | null | undefined,
  pubkey: string
): string | null {
  if (!referer) return null
  let url: URL
  try {
    url = new URL(referer)
  } catch {
    return null
  }
  if (url.protocol !== 'ncc:') return null
  if (url.hostname.toLowerCase() !== pubkey.toLowerCase()) return null

  const raw = url.pathname.replace(/^\/+/, '')
  if (!raw) return null

  if (raw === '_' || raw.startsWith('_/')) {
    const rest = raw.slice(2)
    const service = rest.split('/')[0]
    return service && isValidServiceName(service) ? service : null
  }

  let service: string
  try {
    service = decodeURIComponent(raw.split('/')[0])
  } catch {
    return null
  }
  return service && isValidServiceName(service) ? service : null
}

/** Strip the scheme so the toolbar can show a compact address. */
export function displayAddress(url: string): string {
  return url.replace(/^ncc:\/\//, '')
}
