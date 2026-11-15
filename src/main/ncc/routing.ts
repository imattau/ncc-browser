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

/** Build an endpoint request and attach routing identity for NCC-aware gateways. */
export function upstreamRequestInit(
  request: Request,
  target: URL,
  pubkey: string,
  service: string
): RequestInit {
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')

  // These are routing hints, not credentials. Always replace page-supplied
  // values with the identity and service resolved from the ncc:// address.
  headers.set('x-ncc-pubkey', pubkey)
  headers.set('x-ncc-service', service)

  const origin = headers.get('origin')
  if (origin === `ncc://${pubkey}`) headers.set('origin', target.origin)

  const referer = headers.get('referer')
  if (referer?.startsWith('ncc://')) {
    headers.set('referer', `${target.origin}${target.pathname}`)
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual'
  }

  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }

  return init
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
