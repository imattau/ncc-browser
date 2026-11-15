/**
 * Parser and builders for the `nsite://` address scheme (NIP-5A static sites).
 *
 *   display / input   nsite://<npub>/<d>/<path…>     root site, or a named site
 *   internal          nsite://<npub>.<d>/<path…>     a named site, origin-scoped
 *                     nsite://<npub>/<path…>         the root site
 *
 * Putting the site id in the host makes it part of the origin, so `/assets/app.js` is
 * always the asset of the site that requested it — no Referer, no active-site map, and
 * no chance of reading "assets" as a site called `assets`.
 */

import { isNostrId } from './ncc-url'

export const NSITE_SCHEME = 'nsite'

const D_TAG_RE = /^[a-z0-9-]{1,13}$/

export class NsiteUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NsiteUrlError'
  }
}

export interface NsiteAddress {
  pubkey: string
  /** Named site id, or null for the root site. */
  site: string | null
  /** Always begins with `/`; preserves a trailing slash. */
  path: string
  search: string
  hash: string
  /** True when the URL already used the host-based internal form. */
  internal: boolean
}

export function isValidSiteId(value: string): boolean {
  return D_TAG_RE.test(value) && !value.endsWith('-')
}

export function looksLikeNsiteInput(input: string): boolean {
  return /^nsite:/i.test(input.trim())
}

/** `nsite://<npub>` or `nsite://<npub>/<d>`, used as the storage and signer origin. */
export function nsiteOrigin(pubkey: string, site: string | null): string {
  return site ? `nsite://${pubkey}/${site}` : `nsite://${pubkey}`
}

export interface NsiteHost {
  pubkey: string
  /** Null for the bare-npub host, which is the root site. */
  site: string | null
  /** True when the host carried a site suffix (`<npub>.<d>`). */
  canonical: boolean
}

export function parseNsiteHost(hostname: string): NsiteHost | null {
  const host = hostname.toLowerCase()
  const dot = host.indexOf('.')
  if (dot === -1) {
    return isNostrId(host) ? { pubkey: host, site: null, canonical: false } : null
  }
  const pubkey = host.slice(0, dot)
  if (!isNostrId(pubkey)) return null
  const site = host.slice(dot + 1)
  if (!isValidSiteId(site)) return null
  return { pubkey, site, canonical: true }
}

export function parseNsiteAddress(raw: string): NsiteAddress {
  let input = raw.trim()
  if (!input) throw new NsiteUrlError('Enter an address')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^nsite:\/\//i.test(input)) {
    throw new NsiteUrlError('Only nsite:// addresses are supported here')
  }
  if (/^nsite:/i.test(input) && !/^nsite:\/\//i.test(input)) {
    input = `nsite://${input.slice(6).replace(/^\/+/, '')}`
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new NsiteUrlError('That is not a valid URL')
  }
  if (url.protocol !== 'nsite:') {
    throw new NsiteUrlError('Only nsite:// addresses are supported here')
  }

  const host = parseNsiteHost(url.hostname)
  if (!host) {
    throw new NsiteUrlError(
      'The host must be an npub (npub1…) or a 64-character hex pubkey, optionally followed by a site id'
    )
  }

  const pathname = url.pathname || '/'
  if (host.canonical) {
    return {
      pubkey: host.pubkey,
      site: host.site,
      path: pathname,
      search: url.search,
      hash: url.hash,
      internal: true
    }
  }

  const rawPath = pathname.replace(/^\/+/, '')
  const slash = rawPath.indexOf('/')
  const first = slash === -1 ? rawPath : rawPath.slice(0, slash)
  const rest = slash === -1 ? '' : rawPath.slice(slash)

  let site: string | null = null
  let path: string
  if (first && isValidSiteId(first)) {
    site = first
    path = rest || '/'
  } else if (rawPath) {
    path = `/${rawPath}`
  } else {
    path = '/'
  }

  if (path.includes('\0') || path.split('/').some((segment) => segment === '..')) {
    throw new NsiteUrlError('That path is not allowed')
  }

  return { pubkey: host.pubkey, site, path, search: url.search, hash: url.hash, internal: false }
}

export interface BuildNsiteAddress {
  pubkey: string
  site?: string | null
  path?: string
  search?: string
  hash?: string
  /** End site roots with a slash so relative links stay inside the site. */
  trailingSlash?: boolean
}

/** Clean, user-facing form. */
export function buildNsiteUrl(address: BuildNsiteAddress): string {
  const { pubkey, site = null } = address
  const origin = nsiteOrigin(pubkey, site)
  let path = address.path ?? ''
  if (!path.startsWith('/')) path = `/${path}`
  if (path === '/' || path === '') {
    path = address.trailingSlash === false ? '' : '/'
  }
  return `${origin}${path}${address.search ?? ''}${address.hash ?? ''}`
}

/** Origin-scoped form used for everything the WebContents loads. */
export function toInternalNsiteUrl(address: BuildNsiteAddress): string {
  const { pubkey, site = null } = address
  const host = site ? `${pubkey}.${site}` : pubkey
  let path = address.path ?? '/'
  if (!path.startsWith('/')) path = `/${path}`
  return `nsite://${host}${path}${address.search ?? ''}${address.hash ?? ''}`
}

/** The storage origin for a site: `nsite://<npub>.<d>` (root: `nsite://<npub>`). */
export function nsiteStorageOrigin(pubkey: string, site: string | null): string {
  return site ? `nsite://${pubkey}.${site}` : `nsite://${pubkey}`
}

/** Turn an internal (host) URL into the clean form shown to the user. */
export function toNsiteDisplayUrl(internal: string): string {
  try {
    return buildNsiteUrl(parseNsiteAddress(internal))
  } catch {
    return internal
  }
}
