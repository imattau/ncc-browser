import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Session } from 'electron'

export const NCCSEARCH_SCHEME = 'nccsearch'

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

export function installNccSearchProtocol(
  sessions: Session[],
  assetsDirectory: string,
  config: () => { relays: string[]; pubkey: string | null }
): void {
  const root = resolve(assetsDirectory)
  for (const session of sessions) {
    session.protocol.handle(NCCSEARCH_SCHEME, async (request) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response('Method not allowed', 405)
      let url: URL
      try { url = new URL(request.url) } catch { return response('Not found', 404) }
      if (url.hostname !== 'app') return response('Not found', 404)

      if (url.pathname === '/runtime-config.js') {
        const settings = config()
        const relays = settings.relays.filter((relay) => /^wss?:\/\//i.test(relay)).slice(0, 6)
        const script = `window.NCC_SEARCH_RELAYS_B64=${JSON.stringify(Buffer.from(relays.join(',')).toString('base64'))};window.NCC_SEARCH_PUBKEY=${JSON.stringify(settings.pubkey ?? '')};`
        return response(script, 200, 'text/javascript; charset=utf-8')
      }

      let relative: string
      try { relative = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html' }
      catch { return response('Not found', 404) }
      const file = resolve(root, relative)
      if (!file.startsWith(`${root}${sep}`)) return response('Not found', 404)
      try {
        const data = await readFile(file)
        const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(data), {
          status: 200,
          headers: {
            'content-type': type,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src https:; connect-src 'self' wss: ws: https:; worker-src 'self' blob:; base-uri 'self'"
          }
        })
      } catch { return response('Not found', 404) }
    })
  }
}

function response(body: string, status: number, type = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store' } })
}
