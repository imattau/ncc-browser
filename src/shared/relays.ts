import { DEFAULT_RELAYS } from './types'

/**
 * Validate and normalise a user-supplied relay list.
 * Only ws/wss relay URLs are accepted; the list must not be empty.
 */
export function normalizeRelays(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('Relay list must be an array')

  const relays: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value) continue

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

    const normalized = url.toString().replace(/\/$/, '')
    if (!relays.includes(normalized)) relays.push(normalized)
  }

  if (relays.length === 0) throw new Error('At least one relay is required')
  return relays
}

export function defaultRelays(): string[] {
  return [...DEFAULT_RELAYS]
}
