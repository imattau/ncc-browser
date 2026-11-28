import { getEventHash, verifyEvent, type Event } from 'nostr-tools'

const MAX_PICTURE_BYTES = 512_000
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

export interface PublicProfile {
  pubkey: string
  name?: string
  pictureDataUrl?: string
}

/** Select the newest valid signed kind-0 event and return bounded display metadata. */
export async function publicProfileFromEvents(
  events: Event[],
  pubkeyValue: string,
  fetcher: typeof fetch = fetch
): Promise<PublicProfile | null> {
  const pubkey = pubkeyValue.toLowerCase()
  const event = events
    .filter((entry) => entry.kind === 0 && entry.pubkey === pubkey && entry.id === getEventHash(entry) && verifyEvent(entry))
    .sort((left, right) => right.created_at - left.created_at)[0]
  if (!event) return null

  let content: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(event.content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    content = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const nameValue = typeof content.display_name === 'string' ? content.display_name : content.name
  const name = typeof nameValue === 'string' ? nameValue.trim().slice(0, 80) : ''
  const profile: PublicProfile = { pubkey, ...(name ? { name } : {}) }
  const pictureUrl = safePictureUrl(content.picture)
  if (!pictureUrl) return profile

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetcher(pictureUrl, {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    })
    const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (!response.ok || !response.body || !IMAGE_TYPES.has(type) || declaredLength > MAX_PICTURE_BYTES) return profile

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PICTURE_BYTES) {
        await reader.cancel()
        return profile
      }
      chunks.push(value)
    }
    if (size > 0) {
      profile.pictureDataUrl = `data:${type};base64,${Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('base64')}`
    }
  } catch {
    // Profile names are useful even when their optional picture host is offline.
  } finally {
    clearTimeout(timeout)
  }
  return profile
}

function safePictureUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}
