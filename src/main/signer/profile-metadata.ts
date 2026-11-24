import { verifyEvent, type Event } from 'nostr-tools'
import type { IdentityProfileMetadata } from '@shared/types'
import type { RelayPool } from '../relay/pool'

const PROFILE_TTL_MS = 6 * 60 * 60_000
const MAX_PUBKEYS = 100
const MAX_RELAYS = 12
const MAX_PICTURE_BYTES = 512_000
const FETCH_TIMEOUT_MS = 5_000

/** Best-effort public kind-0 metadata for saved identity profiles. */
export class IdentityProfileMetadataService {
  private readonly cache = new Map<string, { profile: IdentityProfileMetadata; checkedAt: number }>()
  private readonly checkedAt = new Map<string, number>()
  private readonly refreshing = new Set<string>()

  constructor(
    private readonly relays: Pick<RelayPool, 'query'>,
    private readonly relayUrls: () => string[],
    private readonly onChange: (profiles: IdentityProfileMetadata[]) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Returns cached values immediately and refreshes stale or missing profiles in the background. */
  get(pubkeys: unknown): IdentityProfileMetadata[] {
    const keys = normalizePubkeys(pubkeys)
    const now = this.now()
    const stale = keys.filter(
      (pubkey) =>
        !this.refreshing.has(pubkey) &&
        now - (this.checkedAt.get(pubkey) ?? 0) >= PROFILE_TTL_MS
    )
    if (stale.length) void this.refresh(stale)
    return keys.flatMap((pubkey) => {
      const profile = this.cache.get(pubkey)?.profile
      return profile ? [profile] : []
    })
  }

  private async refresh(pubkeys: string[]): Promise<void> {
    const relays = [...new Set(this.relayUrls().filter((url) => /^wss?:\/\//i.test(url)))].slice(
      0,
      MAX_RELAYS
    )
    if (relays.length === 0) {
      pubkeys.forEach((pubkey) => this.checkedAt.set(pubkey, this.now()))
      return
    }
    const keys = pubkeys.filter((pubkey) => !this.refreshing.has(pubkey))
    if (keys.length === 0) return
    keys.forEach((pubkey) => this.refreshing.add(pubkey))

    try {
      const events = await this.relays.query(relays, {
        kinds: [0],
        authors: keys,
        limit: keys.length
      })
      const newest = new Map<string, Event>()
      for (const event of events) {
        if (event.kind !== 0 || !keys.includes(event.pubkey) || !verifyEvent(event)) continue
        const current = newest.get(event.pubkey)
        if (!current || event.created_at > current.created_at) newest.set(event.pubkey, event)
      }

      const updated: IdentityProfileMetadata[] = []
      for (const pubkey of keys) {
        this.checkedAt.set(pubkey, this.now())
        const event = newest.get(pubkey)
        const profile = event ? parseProfile(event) : null
        if (!profile) continue
        this.cache.set(pubkey, { profile, checkedAt: this.now() })
        updated.push(profile)
      }
      if (updated.length) this.onChange(updated)

      const pictured = updated.filter((profile) => profilePictureUrl(newest.get(profile.pubkey)))
      const withPictures = await Promise.all(
        pictured.map(async (profile) => {
          const url = profilePictureUrl(newest.get(profile.pubkey))
          if (!url) return null
          const pictureDataUrl = await fetchPictureDataUrl(url)
          if (!pictureDataUrl) return null
          const current = this.cache.get(profile.pubkey)
          if (!current) return null
          const next = { ...current.profile, pictureDataUrl }
          this.cache.set(profile.pubkey, { ...current, profile: next })
          return next
        })
      )
      const pictureUpdates = withPictures.filter(
        (profile): profile is Exclude<(typeof withPictures)[number], null> => profile !== null
      )
      if (pictureUpdates.length) this.onChange(pictureUpdates)
    } catch {
      // Relay failures are a cache miss; the picker keeps its npub fallback.
      for (const pubkey of keys) this.checkedAt.set(pubkey, this.now())
    } finally {
      keys.forEach((pubkey) => this.refreshing.delete(pubkey))
    }
  }
}

function normalizePubkeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)).map((key) => key.toLowerCase()))].slice(0, MAX_PUBKEYS)
}

function parseProfile(event: Event): IdentityProfileMetadata | null {
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>
    const name = stringValue(value.display_name) || stringValue(value.name)
    if (!name && !safePictureUrl(value.picture)) return null
    return {
      pubkey: event.pubkey.toLowerCase(),
      ...(name ? { name: name.slice(0, 80) } : {})
    }
  } catch {
    return null
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function profilePictureUrl(event: Event | undefined): string | null {
  if (!event) return null
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>
    return safePictureUrl(value.picture)
  } catch {
    return null
  }
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

async function fetchPictureDataUrl(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    if (!response.ok || !response.body) return null
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(contentType)) return null
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_PICTURE_BYTES) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PICTURE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    if (size === 0) return null
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    return `data:${contentType};base64,${bytes.toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
