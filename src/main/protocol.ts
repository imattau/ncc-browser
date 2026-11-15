import { protocol, type Session } from 'electron'
import {
  isNostrId,
  parseNccAddress,
  routeNccPath,
  serviceFromReferer
} from '@shared/ncc-url'
import type { AnchorInfo, TransportSecurity } from '@shared/types'
import { renderErrorPage, renderPlainFailure } from './error-page'
import { orderByHealth, type EndpointHealth } from './ncc/health'
import { joinPaths, rewriteLocation } from './ncc/routing'
import type { NccResolver } from './ncc/resolver'
import {
  hasOnionEndpoint,
  selectTransportEndpoints,
  type TransportPolicy
} from './ncc/transport'
import type { PinStore } from './pins'
import { isAllowedTorRedirect } from './tor/guard'
import type { TorManager } from './tor/manager'

export const NCC_SCHEME = 'ncc'

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]

const FAILURE_STATUS: Record<string, number> = {
  'invalid-address': 400,
  'no-record': 404,
  expired: 410,
  undecryptable: 403,
  'invalid-payload': 502,
  'no-endpoint': 502,
  'relay-error': 503,
  timeout: 504,
  'endpoint-unreachable': 502,
  'k-mismatch': 502,
  'certificate-expired': 502,
  'no-anchor': 404,
  'anchor-expired': 410,
  'anchor-invalid': 502,
  'anchor-k-mismatch': 502,
  'onion-only': 502,
  'tor-unavailable': 503,
  'tor-clearnet-redirect': 403,
  'tor-blocked-resource': 403
}

export interface ProtocolActivity {
  pubkey: string
  service: string
  endpointHost?: string
  transport: TransportSecurity
  pinned: boolean
  /** The locator publishes at least one usable onion endpoint. */
  onionAvailable?: boolean
  /** The document is being served from an onion endpoint. */
  viaTor?: boolean
  anchor?: AnchorInfo | null
  failureCode?: string
}

export interface ProtocolDeps {
  session: Session
  resolver: NccResolver
  pins: PinStore
  health: EndpointHealth
  transport: TransportPolicy
  tor: TorManager
  /** True when this service currently has a document loaded through Tor. */
  isTorService: (pubkey: string, service: string) => boolean
  activeService: Map<string, string>
  /** Endpoint origin → the NCC address it was resolved for, used to rewrite redirects. */
  endpointOwners: Map<string, { pubkey: string; service: string }>
  onActivity: (activity: ProtocolActivity) => void
}

/**
 * Must run before `app.whenReady()`.
 */
export function registerNccScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NCC_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: true
      }
    }
  ])
}

export function installNccProtocol(deps: ProtocolDeps): void {
  deps.session.protocol.handle(NCC_SCHEME, (request) => handleNccRequest(request, deps))
}

async function handleNccRequest(request: Request, deps: ProtocolDeps): Promise<Response> {
  let requestUrl: URL
  try {
    requestUrl = new URL(request.url)
  } catch {
    return failureResponse(request, 'invalid-address', 'Not a valid ncc:// URL', request.url)
  }

  const pubkey = requestUrl.hostname.toLowerCase()
  if (!isNostrId(pubkey)) {
    return failureResponse(
      request,
      'invalid-address',
      'The host of an ncc:// URL must be an npub',
      request.url
    )
  }

  const refererService = serviceFromReferer(request.headers.get('referer'), pubkey)
  const routed = routeNccPath(
    requestUrl.pathname,
    deps.activeService.get(pubkey) ?? null,
    refererService
  )
  if (!routed) {
    return failureResponse(request, 'invalid-address', 'Could not determine the service', request.url)
  }

  const { service, path } = routed
  const outcome = await deps.resolver.resolve(pubkey, service)
  if (!outcome.ok) {
    if (isDocumentRequest(request)) {
      deps.onActivity({
        pubkey,
        service,
        transport: 'unknown',
        pinned: false,
        failureCode: outcome.code
      })
    }
    return failureResponse(request, outcome.code, outcome.message, request.url, outcome.detail)
  }

  const onionAvailable = hasOnionEndpoint(outcome.record.endpoints)
  const documentRequest = isDocumentRequest(request)
  const fromTorPage = !documentRequest && refererUsesTor(request, deps)
  const useTor = deps.transport.useTor(pubkey, service, onionAvailable) || fromTorPage
  const selection = selectTransportEndpoints(outcome.record.endpoints, useTor)

  if (fromTorPage && !onionAvailable) {
    return failureResponse(
      request,
      'tor-blocked-resource',
      'Tor blocked a clearnet NCC resource',
      request.url,
      'The referring Tor page requested a service with no onion endpoint.'
    )
  }

  if (selection.candidates.length === 0) {
    const code = selection.onionOnly ? 'onion-only' : 'no-endpoint'
    if (isDocumentRequest(request)) {
      deps.onActivity({
        pubkey,
        service,
        transport: 'unknown',
        pinned: false,
        onionAvailable,
        viaTor: false,
        failureCode: code
      })
    }
    return failureResponse(
      request,
      code,
      selection.onionOnly
        ? 'This service is available only over Tor'
        : 'The locator has no fetchable endpoints',
      request.url
    )
  }

  if (useTor) {
    try {
      await deps.tor.ensureReady()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isDocumentRequest(request)) {
        deps.onActivity({
          pubkey,
          service,
          transport: 'unknown',
          pinned: false,
          onionAvailable,
          viaTor: true,
          failureCode: 'tor-unavailable'
        })
      }
      return failureResponse(
        request,
        'tor-unavailable',
        'Tor is not available',
        request.url,
        message
      )
    }
  }

  const failures: string[] = []
  let certificateFailure: 'k-mismatch' | 'certificate-expired' | null = null

  for (const endpoint of orderByHealth(selection.candidates, deps.health)) {
    let target: URL
    try {
      target = new URL(endpoint.url)
    } catch {
      failures.push(`invalid endpoint URL: ${endpoint.url}`)
      continue
    }

    target.pathname = joinPaths(target.pathname, path)
    target.search = requestUrl.search

    if (endpoint.k) {
      deps.pins.set(target.hostname, { k: endpoint.k, label: `${pubkey}/${service}` })
    }
    deps.endpointOwners.set(target.origin, { pubkey, service })

    let response: Response
    try {
      response = await deps.session.fetch(target.toString(), forwardedInit(request, target, pubkey))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.health.recordFailure(endpoint.url)
      const rejection = endpoint.k ? deps.pins.consumeRejection(target.hostname) : undefined
      failures.push(`${target.host}: ${message}${rejection ? ` (${rejection.reason})` : ''}`)

      if (rejection) {
        certificateFailure = rejection.reason === 'expired-cert' ? 'certificate-expired' : 'k-mismatch'
        break
      }
      if (/CERT|SSL|TLS/i.test(message)) {
        certificateFailure = 'k-mismatch'
        break
      }
      continue
    }

    deps.health.recordSuccess(endpoint.url)

    if (isDocumentRequest(request)) {
      const transport: TransportSecurity =
        endpoint.protocol === 'https'
          ? endpoint.k && !endpoint.k.includes(':')
            ? 'pinned-tls'
            : 'tls'
          : 'plaintext'
      deps.onActivity({
        pubkey,
        service,
        endpointHost: target.hostname,
        transport,
        pinned: transport === 'pinned-tls',
        onionAvailable,
        viaTor: endpoint.family === 'onion',
        anchor: outcome.record.anchor ?? null
      })
    }

    return toBrowserResponse(
      request,
      response,
      requestUrl,
      target,
      pubkey,
      service,
      deps,
      isDocumentRequest(request),
      endpoint.family === 'onion'
    )
  }

  const code = certificateFailure ?? 'endpoint-unreachable'
  if (isDocumentRequest(request)) {
    deps.onActivity({
      pubkey,
      service,
      transport: 'unknown',
      pinned: false,
      onionAvailable,
      viaTor: useTor,
      failureCode: code
    })
  }
  return failureResponse(
    request,
    code,
    code === 'k-mismatch'
      ? 'The endpoint certificate does not match the locator fingerprint'
      : code === 'certificate-expired'
        ? 'The endpoint certificate has expired'
        : 'Every endpoint in the locator refused the connection',
    request.url,
    failures.join('\n')
  )
}

function forwardedInit(request: Request, target: URL, pubkey: string): RequestInit {
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')

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

function toBrowserResponse(
  request: Request,
  response: Response,
  requestUrl: URL,
  target: URL,
  pubkey: string,
  service: string,
  deps: ProtocolDeps,
  documentRequest: boolean,
  viaTor: boolean
): Response {
  const headers = new Headers(response.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  // fetch already decoded the body, so the originals would corrupt it.
  headers.delete('content-encoding')
  headers.delete('content-length')

  // A top-level ncc:// document is a live view of a locator-bound endpoint. Do not
  // let Chromium serve a stale cached copy; subresources keep the endpoint's policy.
  if (documentRequest) {
    headers.set('cache-control', 'no-store')
    headers.delete('etag')
    headers.delete('last-modified')
  }

  const location = headers.get('location')
  if (location) {
    if (viaTor && !isAllowedTorRedirect(location, target)) {
      if (documentRequest) {
        deps.onActivity({
          pubkey,
          service,
          transport: 'unknown',
          pinned: false,
          onionAvailable: true,
          viaTor: true,
          failureCode: 'tor-clearnet-redirect'
        })
      }
      let host = location
      try {
        host = new URL(location, target).host
      } catch {
        // Keep the raw Location in the detail when it is not a URL.
      }
      return failureResponse(
        request,
        'tor-clearnet-redirect',
        'Tor blocked a clearnet redirect',
        requestUrl.toString(),
        `Blocked redirect to ${host}`
      )
    }
    headers.set(
      'location',
      rewriteLocation(location, {
        pubkey,
        service,
        current: requestUrl,
        endpointOrigin: target.origin,
        endpointOwners: deps.endpointOwners
      })
    )
  }

  if (response.status === 304 || response.status === 204) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers })
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function isDocumentRequest(request: Request): boolean {
  const destination = request.headers.get('sec-fetch-dest')
  if (destination) return destination === 'document'
  return (request.headers.get('accept') ?? '').includes('text/html')
}

/** A subresource is initiated by a page; if that page is on Tor, stay on Tor. */
function refererUsesTor(request: Request, deps: ProtocolDeps): boolean {
  const referer = request.headers.get('referer')
  if (!referer) return false
  try {
    const address = parseNccAddress(referer)
    return deps.isTorService(address.pubkey, address.service)
  } catch {
    return false
  }
}

function failureResponse(
  request: Request,
  code: string,
  message: string,
  address: string,
  detail?: string
): Response {
  const status = FAILURE_STATUS[code] ?? 502
  if (!isDocumentRequest(request)) {
    return new Response(renderPlainFailure(code, message), {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    })
  }
  return new Response(renderErrorPage({ code, message, detail, address }), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}
