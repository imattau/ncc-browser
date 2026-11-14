/**
 * Pure routing helpers for the ncc:// proxy: endpoint path joining and redirect
 * rewriting. Kept separate from protocol.ts so both are unit-testable without
 * Electron.
 */

import { buildInternalUrl } from '@shared/ncc-url'

export interface RewriteContext {
  pubkey: string
  service: string
  /** The ncc:// URL that produced the response. */
  current: URL
  /** Origin of the endpoint that produced the response. */
  endpointOrigin: string
  endpointOwners: Map<string, { pubkey: string; service: string }>
}

/**
 * Rewrite a Location header so the renderer never sees a raw endpoint address.
 * Redirects to other hosts are left alone: the service is telling us to leave NCC.
 */
export function rewriteLocation(location: string, context: RewriteContext): string {
  let resolved: URL
  try {
    resolved = new URL(location, context.current)
  } catch {
    return location
  }

  if (resolved.protocol === 'ncc:') {
    const host = resolved.hostname.toLowerCase()
    if (host !== context.pubkey) return resolved.toString()
    return withService(
      context.pubkey,
      context.service,
      resolved.pathname,
      resolved.search,
      resolved.hash
    )
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return location

  if (resolved.origin === context.endpointOrigin) {
    return buildInternalUrl({
      pubkey: context.pubkey,
      service: context.service,
      path: resolved.pathname,
      search: resolved.search,
      hash: resolved.hash
    })
  }

  const owner = context.endpointOwners.get(resolved.origin)
  if (owner && owner.pubkey === context.pubkey) {
    return buildInternalUrl({
      pubkey: owner.pubkey,
      service: owner.service,
      path: resolved.pathname,
      search: resolved.search,
      hash: resolved.hash
    })
  }

  return location
}

/** Ensure a path inside a service namespace stays inside that service. */
export function withService(
  pubkey: string,
  service: string,
  pathname: string,
  search = '',
  hash = ''
): string {
  const prefix = `/${service}`
  const path =
    pathname === prefix || pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname
  return buildInternalUrl({
    pubkey,
    service,
    path: path || '/',
    search,
    hash
  })
}

/** Join an endpoint's base path with the requested path, preserving slashes. */
export function joinPaths(base: string, path: string): string {
  const cleanBase = base === '/' ? '' : base.replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${cleanBase}${cleanPath}` || '/'
}
