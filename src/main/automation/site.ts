/** The unit a user grants control over: a web origin, or one ncc/nsite service. */
export function siteOf(input: string): string {
  const raw = input.trim()
  if (!raw) return 'about:blank'
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    if (url.protocol === 'ncc:' || url.protocol === 'nsite:') {
      const service = url.pathname.split('/').filter(Boolean)[0]
      return `${url.protocol}//${url.host}${service ? `/${service}` : ''}`
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return raw.slice(0, 80)
  }
}
