/**
 * Parser and builders for the `nsite://` address scheme (NIP-5A static sites).
 *
 * Canonical form:  nsite://<npub>/<d>/<path…>?<query>
 *
 * A named site is the first path segment when it matches the NIP-5A `d` tag grammar
 * (`^[a-z0-9-]{1,13}$`, no trailing `-`). Anything else is a file in the author's root
 * site. That rule is the only way `nsite://npub/logo` and `nsite://npub/index.html`
 * can both be meaningful without guessing.
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

  const pubkey = url.hostname.toLowerCase()
  if (!pubkey) throw new NsiteUrlError('Missing npub: use nsite://<npub>/')
  if (!isNostrId(pubkey)) {
    throw new NsiteUrlError('The host must be an npub (npub1…) or a 64-character hex pubkey')
  }

  const rawPath = url.pathname.replace(/^\/+/, '')
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

  return { pubkey, site, path, search: url.search, hash: url.hash }
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

/** Human-facing form: never shows a bare site root without its slash. */
export function toNsiteDisplayUrl(internal: string): string {
  try {
    return buildNsiteUrl(parseNsiteAddress(internal))
  } catch {
    return internal
  }
}
