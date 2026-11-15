/**
 * Pure routing helpers for the ncc:// proxy: endpoint path joining and redirect
 * rewriting. Kept separate from protocol.ts so both are unit-testable without
 * Electron.
 */

import { buildInternalUrl, parseNccAddress } from '@shared/ncc-url'

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
 * Build an endpoint request for an NCC gateway.
 *
 * No longer attaches x-ncc-pubkey/x-ncc-service: nothing reads them back
 * (grepped the whole codebase to confirm) and nothing but our own
 * ncc-server ever consumed them server-side, which has since moved to one
 * dedicated port per service instead of routing by these headers on a
 * shared origin. Keeping them would still buy nothing now that the one
 * consumer is gone, and actively cost something: their mere presence on an
 * otherwise-simple GET/HEAD forces the Fetch spec's "not a simple request"
 * classification, requiring an OPTIONS preflight before every single
 * subresource load (script, stylesheet, image) a page makes -- which only
 * works at all if the destination server bothers to answer OPTIONS
 * correctly, something more than one third-party app we don't control the
 * source of (npanel, ditto-web) got wrong in exactly this way. Dropping
 * them removes that whole failure mode, not just the extra round-trip.
 */
export function upstreamRequestInit(
  request: Request,
  target: URL,
  pubkey: string,
  _service: string
): RequestInit {
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')

  const origin = headers.get('origin')
  // Content origins are `ncc://<npub>.<service>`; upstreams must see a normal origin.
  if (origin?.toLowerCase().startsWith('ncc://')) headers.set('origin', target.origin)

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
    try {
      const address = parseNccAddress(resolved.toString())
      if (address.pubkey !== context.pubkey) return resolved.toString()
      return buildInternalUrl({
        pubkey: address.pubkey,
        service: address.service,
        path: address.path || '/',
        search: address.search,
        hash: address.hash
      })
    } catch {
      return resolved.toString()
    }
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

/** Join an endpoint's base path with the requested path, preserving slashes. */
export function joinPaths(base: string, path: string): string {
  const cleanBase = base === '/' ? '' : base.replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${cleanBase}${cleanPath}` || '/'
}
