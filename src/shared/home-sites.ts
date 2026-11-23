export interface HomeSite {
  url: string
  title: string
  icon?: string
}

export function normalizeHomeSite(value: unknown): HomeSite | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<HomeSite>
  if (typeof input.url !== 'string' || input.url.length > 4096) return null
  let url: URL
  try { url = new URL(input.url) } catch { return null }
  if (!['http:', 'https:', 'ncc:', 'nsite:'].includes(url.protocol)) return null
  const title = typeof input.title === 'string' ? input.title.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
  const icon = typeof input.icon === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(input.icon) && input.icon.length <= 90_000
    ? input.icon
    : undefined
  return { url: url.toString(), title: title || url.hostname || url.toString(), ...(icon ? { icon } : {}) }
}
