import { nip19 } from 'nostr-tools'
import { DEFAULT_RELAYS, type RelayEntry, type RelayLocatorRef } from './types'

/**
 * Validate and normalise a user-supplied relay list to plain URLs.
 * Only ws/wss relay URLs are accepted; the list must not be empty.
 */
export function normalizeRelays(input: unknown): string[] {
  return normalizeRelayEntries(input).map((entry) => entry.url)
}

export function defaultRelays(): string[] {
  return [...DEFAULT_RELAYS]
}

/** Default service for a bare `ncc://<npub>` relay entry. */
export const DEFAULT_RELAY_SERVICE = 'relay'

export interface ParsedRelayLocator {
  /** The identity exactly as typed (npub or hex). */
  identity: string
  /** Hex pubkey. */
  pubkey: string
  service: string
  /** Canonical `ncc://` form for storage and display. */
  uri: string
}

/**
 * Parse `ncc://<npub-or-hex>/<service>` as used for relay entries.
 *
 * A bare `ncc://<npub>` means the `relay` service, since that is the only thing a
 * relay field can address. Returns `null` for anything that is not an NCC address,
 * including plain `wss://` URLs, which callers keep handling as before.
 */
export function parseRelayLocator(input: string): ParsedRelayLocator | null {
  const value = input.trim()
  const match = /^ncc:\/\/([^/?#]+)(?:\/([^/?#]+))?\/?$/i.exec(value)
  if (!match) return null

  const identity = match[1]
  let pubkey: string
  if (/^[0-9a-f]{64}$/i.test(identity)) {
    pubkey = identity.toLowerCase()
  } else if (identity.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(identity)
      if (decoded.type !== 'npub') return null
      pubkey = decoded.data as string
    } catch {
      return null
    }
  } else {
    return null
  }

  let service = match[2] ? decodeURIComponent(match[2]) : DEFAULT_RELAY_SERVICE
  // Service names are `d` tags, so they cannot carry path separators or spaces.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(service)) return null

  return { identity, pubkey, service, uri: `ncc://${identity}/${service}` }
}

function normalizeRelayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Not a valid relay URL: ${value}`)
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(`Relays must use ws:// or wss://: ${value}`)
  }
  if (url.hash) throw new Error(`Relay URLs cannot contain a fragment: ${value}`)
  return url.toString().replace(/\/$/, '')
}

/** Validate locator metadata read from disk. Anything malformed is dropped. */
function normalizeLocator(input: unknown): RelayLocatorRef | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  if (typeof raw.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.pubkey)) return undefined
  if (typeof raw.service !== 'string' || !raw.service.trim()) return undefined
  if (typeof raw.dTag !== 'string' || !raw.dTag.trim()) return undefined
  const expiresAt = Number(raw.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return undefined

  const identity =
    typeof raw.identity === 'string' && raw.identity.trim()
      ? raw.identity.trim()
      : `ncc://${raw.pubkey.toLowerCase()}/${raw.service.trim()}`

  return {
    identity,
    pubkey: raw.pubkey.toLowerCase(),
    service: raw.service.trim(),
    dTag: raw.dTag.trim(),
    expiresAt,
    k: typeof raw.k === 'string' && raw.k.trim() ? raw.k.trim() : null
  }
}

/**
 * Normalise relay entries from settings or disk. Accepts both the legacy shape
 * (`string[]`) and `RelayEntry[]`, so an existing `config.json` keeps working.
 */
export function normalizeRelayEntries(input: unknown): RelayEntry[] {
  if (!Array.isArray(input)) throw new Error('Relay list must be an array')

  const entries: RelayEntry[] = []
  const seen = new Set<string>()

  for (const item of input) {
    if (typeof item === 'string') {
      const value = item.trim()
      if (!value) continue
      const url = normalizeRelayUrl(value)
      if (seen.has(url)) continue
      seen.add(url)
      entries.push({ url })
      continue
    }

    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.url !== 'string' || !raw.url.trim()) continue

    const url = normalizeRelayUrl(raw.url)
    if (seen.has(url)) continue
    seen.add(url)

    const locator = normalizeLocator(raw.locator)
    entries.push({
      url,
      ...(locator ? { locator } : {}),
      ...(raw.stale === true ? { stale: true } : {})
    })
  }

  if (entries.length === 0) throw new Error('At least one relay is required')
  return entries
}

/** Resolved URLs, ready to hand to a relay pool. */
export function relayUrls(entries: readonly RelayEntry[]): string[] {
  return entries.map((entry) => entry.url)
}

/** True when a relay URL points at an onion service. */
export function isOnionRelayUrl(url: string): boolean {
  try {
    return new URL(url).hostname.replace(/\.+$/, '').endsWith('.onion')
  } catch {
    return false
  }
}
