import type { Session } from 'electron'

const MAX_FAVICON_BYTES = 256 * 1024
const FAVICON_TIMEOUT_MS = 5000
const MAX_CACHE_ENTRIES = 120

const cache = new Map<string, string | null>()

export function isImageMime(mime: string): boolean {
  return /^image\/[a-z0-9.+-]+$/i.test(mime.split(';')[0].trim())
}

export function faviconDataUrl(mime: string, data: Buffer): string | null {
  const type = mime.split(';')[0].trim().toLowerCase()
  if (!isImageMime(type) || data.length === 0 || data.length > MAX_FAVICON_BYTES) return null
  return `data:${type};base64,${data.toString('base64')}`
}

/**
 * Fetch a page icon through the content session and turn it into a data URL. The
 * chrome renderer never loads a remote URL directly, so a page cannot use its icon
 * to observe the browser UI. `referer` is the page URL, which the `ncc://` handler
 * needs to attribute root-relative icon paths to the right service.
 */
export async function fetchFavicon(
  session: Session,
  url: string,
  referer: string
): Promise<string | null> {
  if (!/^(https?|ncc):\/\//i.test(url)) return null
  if (cache.has(url)) return cache.get(url) ?? null

  let dataUrl: string | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS)

  try {
    const response = await session.fetch(url, {
      headers: { referer },
      signal: controller.signal
    })
    if (response.ok) {
      const mime = response.headers.get('content-type') ?? ''
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (isImageMime(mime) && (!declared || declared <= MAX_FAVICON_BYTES) && response.body) {
        const chunks: Buffer[] = []
        let size = 0
        const reader = response.body.getReader()
        while (size <= MAX_FAVICON_BYTES) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_FAVICON_BYTES) {
            void reader.cancel()
            break
          }
          chunks.push(Buffer.from(value))
        }
        if (size <= MAX_FAVICON_BYTES) dataUrl = faviconDataUrl(mime, Buffer.concat(chunks))
      }
    }
  } catch {
    // A missing icon is normal; keep the tab on its fallback.
  } finally {
    clearTimeout(timer)
  }

  cache.set(url, dataUrl)
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return dataUrl
}

/** Test seam: the icon cache is process-wide. */
export function clearFaviconCache(): void {
  cache.clear()
}
