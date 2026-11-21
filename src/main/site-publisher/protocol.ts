/**
 * `nccpublish://app` — the bundled static-site publisher.
 *
 * A normal tab only: publishing a site needs the durable identity and a folder picker.
 * The page is a plain Vite build; this handler serves it with a CSP that allows exactly
 * the two network jobs it has (Blossom over https, relays over wss).
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Session } from 'electron'

export const SITE_PUBLISHER_SCHEME = 'nccpublish'
export const SITE_PUBLISHER_URL = `${SITE_PUBLISHER_SCHEME}://app/`

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  'connect-src https: wss:',
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export function installSitePublisherProtocol(session: Session, assetsDirectory: string): void {
  const root = resolve(assetsDirectory)
  session.protocol.handle(SITE_PUBLISHER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return text('Not found', 404)
    }
    if (url.hostname !== 'app') return text('Not found', 404)

    let relative: string
    try {
      relative = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html'
    } catch {
      return text('Not found', 404)
    }
    // SPA fallback: a path without an extension is the page itself.
    if (!extname(relative)) relative = 'index.html'

    const file = resolve(root, relative)
    if (file !== root && !file.startsWith(`${root}${sep}`)) return text('Not found', 404)
    try {
      const data = await readFile(file)
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(data), {
        status: 200,
        headers: {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': CSP
        }
      })
    } catch {
      return text('Not found', 404)
    }
  })
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })
}
