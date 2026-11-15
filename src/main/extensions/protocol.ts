/**
 * `ncc-ext://<id>/…` serves installed extension pages and assets. It is registered as
 * a secure, standard scheme so extension pages get a real origin, fetch and CSP.
 */

import { protocol, type Session } from 'electron'
import { extname } from 'node:path'
import { EXTENSION_SCHEME, type ExtensionManifest } from '@shared/extensions'
import type { ExtensionRegistry } from './registry'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

export function extensionPageUrl(id: string, path = ''): string {
  return `${EXTENSION_SCHEME}://${id}/${path.replace(/^\/+/, '')}`
}

export function installExtensionProtocol(
  sessions: Session[],
  registry: ExtensionRegistry
): void {
  for (const session of sessions) {
    session.protocol.handle(EXTENSION_SCHEME, (request) => serve(request, registry))
  }
}

function serve(request: Request, registry: ExtensionRegistry): Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  const id = url.hostname.toLowerCase()
  const record = registry.get(id)
  if (!record) return notFound()

  if (url.pathname === '/__ncc_background__.html') {
    return backgroundPage(record.manifest)
  }

  let relative: string
  try {
    relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return notFound()
  }
  if (!relative) return notFound()

  const file = registry.resolveFile(id, relative)
  if (!file) return notFound()
  const data = registry.readResource(id, relative)
  if (!data) return notFound()

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const accessible = isWebAccessible(record.manifest, relative)
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': accessible ? 'cross-origin' : 'same-origin'
  }
  if (accessible) headers['access-control-allow-origin'] = '*'
  if (type.startsWith('text/html')) {
    headers['content-security-policy'] = contentSecurityPolicy(record.manifest)
  }
  return new Response(new Uint8Array(data), { status: 200, headers })
}

function backgroundPage(manifest: ExtensionManifest): Response {
  const worker = manifest.background
  if (!worker) return notFound()
  const type = worker.type === 'module' ? ' type="module"' : ''
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(manifest.name)}</title></head>
<body><script${type} src="/${escapeHtml(worker.service_worker)}"></script></body></html>`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': contentSecurityPolicy(manifest)
    }
  })
}

/**
 * Extension pages may load packaged scripts and talk to declared hosts, but they
 * cannot run inline script or eval. Host permissions are enforced at the API layer;
 * this CSP keeps the page itself honest.
 */
function contentSecurityPolicy(manifest: ExtensionManifest): string {
  const connect = new Set<string>(["'self'"])
  for (const pattern of manifest.host_permissions) {
    if (pattern === '<all_urls>') {
      connect.add('https:')
      connect.add('http:')
      connect.add('wss:')
      connect.add('ws:')
      continue
    }
    const parsed = /^(\*|https?|ncc):\/\/([^/]+)\//i.exec(pattern)
    if (!parsed) continue
    const scheme = parsed[1].toLowerCase()
    const host = parsed[2]
    if (scheme === 'ncc') {
      connect.add('ncc:')
      continue
    }
    if (scheme === '*' || scheme === 'https') {
      connect.add(`https://${host}`)
      connect.add(`wss://${host}`)
    }
    if (scheme === '*' || scheme === 'http') {
      connect.add(`http://${host}`)
      connect.add(`ws://${host}`)
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

function isWebAccessible(manifest: ExtensionManifest, path: string): boolean {
  return manifest.web_accessible_resources.some((pattern) => {
    if (pattern === '*') return true
    if (!pattern.includes('*')) return pattern === path
    return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(path)
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
