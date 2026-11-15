/**
 * `nsite://` protocol handler: NIP-5A manifests over relays, files over Blossom.
 *
 * Every byte is checked against the sha256 in a signed manifest before it reaches the
 * renderer, so there is no server identity to trust and nothing to pin.
 */

import type { Session } from 'electron'
import { renderErrorPage } from '../error-page'
import { buildNsiteUrl, parseNsiteAddress } from '@shared/nsite-url'
import type { NsiteInfo } from '@shared/types'
import type { NsiteBlobs } from './blob'
import { matchPath, type NsiteManifest } from './manifest'
import type { NsiteResolver } from './resolver'

export const NSITE_SCHEME = 'nsite'

export interface NsiteActivity {
  pubkey: string
  site: string | null
  failureCode?: string
  manifest?: NsiteInfo
}

export interface NsiteDeps {
  session: Session
  resolver: NsiteResolver
  blobs: NsiteBlobs
  onActivity: (activity: NsiteActivity) => void
}

export function installNsiteProtocol(deps: NsiteDeps): void {
  deps.session.protocol.handle(NSITE_SCHEME, (request) => handle(request, deps))
}

async function handle(request: Request, deps: NsiteDeps): Promise<Response> {
  const isDocument = isDocumentRequest(request)

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }
    })
  }

  let address
  try {
    address = parseNsiteAddress(request.url)
  } catch (error) {
    return failure(
      request,
      'invalid-address',
      error instanceof Error ? error.message : 'Not a valid nsite address'
    )
  }

  const outcome = await deps.resolver.resolve(address.pubkey, address.site)
  if (!outcome.ok) {
    if (isDocument) {
      deps.onActivity({
        pubkey: address.pubkey,
        site: address.site,
        failureCode: outcome.code
      })
    }
    return failure(request, outcome.code, outcome.message, outcome.detail)
  }

  const manifest = outcome.manifest
  const match = matchPath(manifest.paths, address.path, address.search)

  if (match.kind === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: {
        location: buildNsiteUrl({
          pubkey: manifest.pubkey,
          site: manifest.site,
          path: match.location
        }),
        'cache-control': 'no-store'
      }
    })
  }

  let hash: string
  let servedPath: string
  let status = 200
  if (match.kind === 'file') {
    hash = match.hash
    servedPath = match.path
  } else {
    const notFound = manifest.paths.get('/404.html')
    if (!notFound) {
      if (isDocument) {
        deps.onActivity({ pubkey: address.pubkey, site: address.site, failureCode: 'no-file' })
      }
      return failure(request, 'no-file', `The site does not publish ${address.path}`)
    }
    hash = notFound
    servedPath = '/404.html'
    status = 404
  }

  const blob = await deps.blobs.get(hash, manifest.servers, servedPath)
  if (!blob.ok) {
    if (isDocument) {
      deps.onActivity({
        pubkey: address.pubkey,
        site: address.site,
        failureCode: blob.code
      })
    }
    return failure(request, blob.code, blob.message)
  }

  if (isDocument) {
    deps.onActivity({
      pubkey: address.pubkey,
      site: address.site,
      manifest: describe(manifest)
    })
  }

  const headers: Record<string, string> = {
    'content-type': blob.type,
    'content-length': String(blob.bytes.length),
    'x-content-type-options': 'nosniff',
    // The manifest can rotate at any time; the file behind a path may change with it.
    'cache-control': servedPath.endsWith('.html') ? 'no-cache' : 'public, max-age=300'
  }

  return new Response(request.method === 'HEAD' ? null : new Uint8Array(blob.bytes), {
    status,
    headers
  })
}

function describe(manifest: NsiteManifest): NsiteInfo {
  return {
    site: manifest.site,
    title: manifest.title,
    description: manifest.description,
    source: manifest.source,
    eventId: manifest.eventId,
    updatedAt: manifest.updatedAt,
    aggregate: manifest.aggregate,
    servers: manifest.servers,
    files: manifest.paths.size
  }
}

function failure(
  request: Request,
  code: string,
  message: string,
  detail?: string
): Response {
  const address = request.url
  if (!isDocumentRequest(request)) {
    return new Response(`${code}: ${message}`, {
      status: statusFor(code),
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    })
  }
  return new Response(renderErrorPage({ code, message, detail, address }), {
    status: statusFor(code),
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}

function statusFor(code: string): number {
  switch (code) {
    case 'invalid-address':
      return 400
    case 'no-manifest':
    case 'no-file':
      return 404
    case 'timeout':
      return 504
    case 'relay-error':
    case 'blob-unavailable':
      return 503
    case 'hash-mismatch':
    case 'manifest-invalid':
      return 502
    case 'too-large':
      return 413
    default:
      return 502
  }
}

function isDocumentRequest(request: Request): boolean {
  const destination = request.headers.get('sec-fetch-dest')
  if (destination) return destination === 'document'
  return (request.headers.get('accept') ?? '').includes('text/html')
}
