import { verifyEvent, type Event, type Filter } from 'nostr-tools'

const PROFILE_KIND = 0
const NSITE_ROOT_KIND = 15128
const NSITE_NAMED_KIND = 35128
const MAX_PICTURE_BYTES = 1_000_000
const FETCH_TIMEOUT_MS = 5_000

export interface AgentProfileQuery {
  (relays: string[], filter: Filter): Promise<Event[]>
}

export interface AgentProfileInfo {
  name?: string
  /** A `data:` URL, already fetched and size/type-checked — safe to drop into an `<img>`. */
  pictureDataUrl?: string
}

export interface AgentProfileResult {
  profile: AgentProfileInfo | null
  nsiteAddress: string | null
}

/**
 * Best-effort public lookup: does this agent's pubkey have a profile (kind 0) and/or a
 * published nsite (kind 15128/35128)? Read-only and cheap to get wrong — callers treat a
 * failure the same as "nothing found yet", never as an error to surface.
 */
export async function fetchAgentProfile(
  query: AgentProfileQuery,
  relays: string[],
  pubkey: string
): Promise<AgentProfileResult> {
  if (relays.length === 0) return { profile: null, nsiteAddress: null }
  const owner = pubkey.toLowerCase()
  const events = await query(relays, {
    kinds: [PROFILE_KIND, NSITE_ROOT_KIND, NSITE_NAMED_KIND],
    authors: [owner],
    limit: 50
  })

  const profileEvent = newest(events.filter((event) => event.kind === PROFILE_KIND))
  const manifestEvent = newest(
    events.filter((event) => event.kind === NSITE_ROOT_KIND || event.kind === NSITE_NAMED_KIND)
  )

  const parsed = profileEvent ? parseProfileContent(profileEvent) : null
  const profile = parsed
    ? { ...(parsed.name ? { name: parsed.name } : {}), ...(await pictureDataUrl(parsed.picture)) }
    : null

  return {
    profile: profile && Object.keys(profile).length > 0 ? profile : null,
    nsiteAddress: manifestEvent ? nsiteAddressOf(owner, manifestEvent) : null
  }
}

function newest(events: Event[]): Event | null {
  return events.reduce<Event | null>((best, event) => {
    if (!best) return event
    if (event.created_at > best.created_at) return event
    if (event.created_at === best.created_at && event.id > best.id) return event
    return best
  }, null)
}

function parseProfileContent(event: Event): { name?: string; picture?: string } | null {
  if (!verifyEvent(event)) return null
  try {
    const parsed = JSON.parse(event.content) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      ...(typeof parsed.name === 'string' && parsed.name.trim()
        ? { name: parsed.name.trim().slice(0, 80) }
        : {}),
      ...(typeof parsed.picture === 'string' && /^https:\/\//i.test(parsed.picture)
        ? { picture: parsed.picture.slice(0, 2048) }
        : {})
    }
  } catch {
    return null
  }
}

function nsiteAddressOf(owner: string, manifest: Event): string | null {
  if (!verifyEvent(manifest)) return null
  const site = manifest.kind === NSITE_ROOT_KIND ? null : manifest.tags.find((tag) => tag[0] === 'd')?.[1]
  if (manifest.kind !== NSITE_ROOT_KIND && !site) return null
  return site ? `nsite://${owner}/${site}/` : `nsite://${owner}/`
}

/** Fetches an https picture URL and converts it to a size/type-checked `data:` URL. */
async function pictureDataUrl(url: string | undefined): Promise<{ pictureDataUrl?: string }> {
  if (!url) return {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return {}
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('image/')) return {}
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_PICTURE_BYTES) return {}
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_PICTURE_BYTES) return {}
    return { pictureDataUrl: `data:${contentType};base64,${buffer.toString('base64')}` }
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}
