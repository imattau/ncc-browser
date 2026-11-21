import type { Session } from 'electron'
import { parseNccAddress, toInternalUrl } from '@shared/ncc-url'
import type { AnchorInfo, LocatorInfo, ResolvedService, TransportSecurity } from '@shared/types'
import { renderErrorPage, renderHttpWarningPage, renderPlainFailure } from './error-page'
import { orderByHealth, type EndpointHealth } from './ncc/health'
import { joinPaths, rewriteLocation, upstreamRequestInit } from './ncc/routing'
import { toHexPubkey, type NccResolver } from './ncc/resolver'
import {
  hasOnionEndpoint,
  selectTransportEndpoints,
  sortCandidatesForHttps,
  type TransportPolicy
} from './ncc/transport'
import type { PinStore } from './pins'
import { isAllowedTorRedirect } from './tor/guard'
import type { TorManager } from './tor/manager'
import { nccEndpointNeedsWarning, nccHttpKey, type HttpPolicy } from './security'

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
  'tor-blocked-resource': 403,
  'insecure-blocked': 403
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
  /** The selected endpoint itself is an onion endpoint. */
  viaOnion?: boolean
  anchor?: AnchorInfo | null
  /** The NCC-05 record behind this document, for the site panel. */
  locator?: LocatorInfo | null
  failureCode?: string
  /** The locator has an onion endpoint and Tor is preferred: open it in a Tor tab instead. */
  torRedirect?: boolean
}

export interface ProtocolDeps {
  session: Session
  resolver: NccResolver
  pins: PinStore
  health: EndpointHealth
  transport: TransportPolicy
  tor: TorManager
  /** This session is a full Tor tab: all traffic uses the fixed proxy. */
  forceTor?: boolean
  /** Enforce onion-only redirects/resources (normal/private onion pages). */
  strictTor?: boolean
  httpPolicy: HttpPolicy
  /** True when this service currently has a document loaded through Tor. */
  isTorService: (pubkey: string, service: string) => boolean

  /** Endpoint origin → the NCC address it was resolved for, used to rewrite redirects. */
  endpointOwners: Map<string, { pubkey: string; service: string }>
  onActivity: (activity: ProtocolActivity) => void
}

export function installNccProtocol(deps: ProtocolDeps): void {
  deps.session.protocol.handle(NCC_SCHEME, (request) => handleNccRequest(request, deps))
}

async function handleNccRequest(
  request: Request,
  deps: ProtocolDeps,
  allowRetry = true
): Promise<Response> {
  let requestUrl: URL
  try {
    requestUrl = new URL(request.url)
  } catch {
    return failureResponse(request, 'invalid-address', 'Not a valid ncc:// URL', request.url)
  }

  const forwardedSearch = new URLSearchParams(requestUrl.search)
  forwardedSearch.delete('ncc-http-ok')
  const endpointSearch = forwardedSearch.toString()
    ? `?${forwardedSearch.toString()}`
    : ''

  // The clean form (`ncc://<npub>/<service>/…`) is input only. Everything the content
  // view loads uses the host form, where the service is part of the origin.
  let address
  try {
    address = parseNccAddress(request.url)
  } catch (error) {
    return failureResponse(
      request,
      'invalid-address',
      error instanceof Error ? error.message : 'Not a valid ncc:// URL',
      request.url
    )
  }
  if (!address.internal) {
    return new Response(null, {
      status: 302,
      headers: { location: toInternalUrl(address), 'cache-control': 'no-store' }
    })
  }

  const pubkey = address.pubkey
  const service = address.service
  const path = address.path || '/'

  // The warning page's continue link carries a one-time token. Consuming it stores
  // the user's HTTP exception for this service and redirects to the clean address.
  const warningToken = requestUrl.searchParams.get('ncc-http-ok')
  if (warningToken) {
    const key = deps.httpPolicy.consumeToken(warningToken)
    if (key === nccHttpKey(pubkey, service)) {
      deps.httpPolicy.allow(key)
      const clean = new URL(requestUrl.toString())
      clean.searchParams.delete('ncc-http-ok')
      return new Response(null, {
        status: 302,
        headers: { location: clean.toString(), 'cache-control': 'no-store' }
      })
    }
  }

  if (deps.forceTor) {
    try {
      await deps.tor.ensureReady()
    } catch (error) {
      if (isDocumentRequest(request)) {
        deps.onActivity({
          pubkey,
          service,
          transport: 'unknown',
          pinned: false,
          viaTor: true,
          failureCode: 'tor-unavailable'
        })
      }
      return failureResponse(
        request,
        'tor-unavailable',
        'Tor is not available',
        request.url,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

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
  const strict = deps.strictTor !== false
  const fromTorPage = strict && !documentRequest && refererUsesTor(request, deps)
  // Only Tor tabs use Tor. With "Prefer Tor" on, a document that has an onion
  // endpoint is handed to a Tor tab rather than fetched over Tor in this tab.
  if (
    deps.forceTor !== true &&
    documentRequest &&
    deps.transport.useTor(pubkey, service, onionAvailable)
  ) {
    deps.onActivity({
      pubkey,
      service,
      transport: 'unknown',
      pinned: false,
      onionAvailable: true,
      torRedirect: true
    })
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Opened in a Tor tab</title>' +
        '<body style="font:14px system-ui;padding:2rem">Opened in a Tor tab.</body>',
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      }
    )
  }
  const useTor = deps.forceTor === true || fromTorPage
  const selection = selectTransportEndpoints(outcome.record.endpoints, useTor)

  if (strict && fromTorPage && !onionAvailable) {
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

  const httpsMode = deps.httpPolicy.mode()
  for (const endpoint of orderByHealth(
    sortCandidatesForHttps(selection.candidates, httpsMode),
    deps.health
  )) {
    let target: URL
    try {
      target = new URL(endpoint.url)
    } catch {
      failures.push(`invalid endpoint URL: ${endpoint.url}`)
      continue
    }

    const key = nccHttpKey(pubkey, service)
    if (nccEndpointNeedsWarning(endpoint) && !deps.httpPolicy.isAllowed(key)) {
      const needsPrompt = httpsMode === 'only' || deps.httpPolicy.warn()
      if (needsPrompt) {
        if (documentRequest) {
          const token = deps.httpPolicy.createToken(key)
          const continueUrl = new URL(requestUrl.toString())
          continueUrl.searchParams.set('ncc-http-ok', token)
          deps.onActivity({
            pubkey,
            service,
            endpointHost: target.hostname,
            transport: 'plaintext',
            pinned: false,
            onionAvailable,
            viaTor: deps.forceTor === true || endpoint.family === 'onion',
            viaOnion: endpoint.family === 'onion',
            anchor: outcome.record.anchor ?? null,
            locator: locatorSummary(outcome.record)
          })
          return new Response(
            renderHttpWarningPage({
              address: requestUrl.toString(),
              host: target.hostname,
              service,
              mode: httpsMode,
              continueUrl: continueUrl.toString()
            }),
            {
              status: 200,
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store'
              }
            }
          )
        }
        return failureResponse(
          request,
          'insecure-blocked',
          'Insecure connection blocked',
          request.url
        )
      }
    }

    target.pathname = joinPaths(target.pathname, path)
    target.search = endpointSearch

    if (endpoint.k) {
      deps.pins.set(target.hostname, { k: endpoint.k, label: `${pubkey}/${service}` })
    }
    deps.endpointOwners.set(target.origin, { pubkey, service })

    let response: Response
    try {
      response = await deps.session.fetch(
        target.toString(),
        upstreamRequestInit(request, target, toHexPubkey(pubkey) ?? pubkey, service)
      )
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
        viaTor: deps.forceTor === true || endpoint.family === 'onion',
        viaOnion: endpoint.family === 'onion',
        anchor: outcome.record.anchor ?? null,
        locator: locatorSummary(outcome.record)
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
      strict && endpoint.family === 'onion'
    )
  }

  const code = certificateFailure ?? 'endpoint-unreachable'

  // A publisher can rotate its endpoint at any time. When nothing in the record
  // accepts a connection, ask relays once more instead of retrying the same dead
  // endpoint until the record's TTL runs out.
  if (
    allowRetry &&
    documentRequest &&
    code === 'endpoint-unreachable' &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    deps.resolver.invalidate(pubkey, service)
    return handleNccRequest(request, deps, false)
  }

  if (isDocumentRequest(request)) {
    deps.onActivity({
      pubkey,
      service,
      transport: 'unknown',
      pinned: false,
      onionAvailable,
      viaTor: useTor,
      viaOnion: false,
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

/** The record fields the site panel shows, without endpoints or anchors. */
function locatorSummary(record: ResolvedService): LocatorInfo {
  return {
    eventId: record.eventId,
    dTag: record.dTag,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    stale: record.stale === true,
    fallback: record.anchor?.fallback === true,
    encrypted: record.encrypted,
    ...(record.notes ? { notes: record.notes } : {})
  }
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
