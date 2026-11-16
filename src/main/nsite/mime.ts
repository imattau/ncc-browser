const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function mimeForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  return TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Pick the type to serve a site file with.
 *
 * A Blossom server is a content-addressed file store: many answer `text/plain` (or
 * `application/octet-stream`) for everything they hold. Trusting that would render an
 * index page as source text and break `<script type="module">`, which enforces the
 * type. The path extension is authoritative when we know it; the upstream header only
 * decides for extensionless paths.
 */
export function contentTypeFor(path: string, upstream?: string | null): string {
  const guessed = mimeForPath(path)
  if (guessed !== 'application/octet-stream') return guessed
  const fallback = upstream?.trim()
  return fallback ? fallback : guessed
}
