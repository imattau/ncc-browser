import { protocol, type Session } from 'electron'
import { isNostrId, routeNccPath } from '@shared/ncc-url'
import type { TransportSecurity } from '@shared/types'
import { renderErrorPage, renderPlainFailure } from './error-page'
import { joinPaths, rewriteLocation } from './ncc/routing'
import type { NccResolver } from './ncc/resolver'
import type { PinStore } from './pins'

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
  'k-mismatch': 502
}

export interface ProtocolActivity {
  pubkey: string
  service: string
  endpointHost?: string
  transport: TransportSecurity
  pinned: boolean
  failureCode?: string
}

export interface ProtocolDeps {
  session: Session
  resolver: NccResolver
  pins: PinStore
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

  const routed = routeNccPath(requestUrl.pathname, deps.activeService.get(pubkey) ?? null)
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

  const failures: string[] = []
  let certificateFailure = false

  for (const endpoint of outcome.record.endpoints) {
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
      failures.push(`${target.host}: ${message}`)
      if (/CERT|SSL|TLS/i.test(message)) {
        certificateFailure = true
        break
      }
      continue
    }

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
        pinned: transport === 'pinned-tls'
      })
    }

    return toBrowserResponse(response, requestUrl, target, pubkey, service, deps)
  }

  const code = certificateFailure ? 'k-mismatch' : 'endpoint-unreachable'
  if (isDocumentRequest(request)) {
    deps.onActivity({
      pubkey,
      service,
      transport: 'unknown',
      pinned: false,
      failureCode: code
    })
  }
  return failureResponse(
    request,
    code,
    code === 'k-mismatch'
      ? 'The endpoint certificate does not match the locator fingerprint'
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
  response: Response,
  requestUrl: URL,
  target: URL,
  pubkey: string,
  service: string,
  deps: ProtocolDeps
): Response {
  const headers = new Headers(response.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  // fetch already decoded the body, so the originals would corrupt it.
  headers.delete('content-encoding')
  headers.delete('content-length')

  const location = headers.get('location')
  if (location) {
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
