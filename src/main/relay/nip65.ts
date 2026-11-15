import { verifyEvent, type Event, type Filter } from 'nostr-tools'

/**
 * NIP-65 discovery for the local identity's write relays. The resolver's gossip
 * helper deliberately reads only read-marked relays for other people; a vault needs
 * the relays where the user actually publishes.
 */
export function extractWriteRelays(event: Event): string[] {
  if (event.kind !== 10002) return []
  const relays: string[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || !tag[1]) continue
    if (tag[2] === 'read') continue
    let url: URL
    try {
      url = new URL(tag[1])
    } catch {
      continue
    }
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue
    const value = tag[1].replace(/\/$/, '')
    if (!relays.includes(value)) relays.push(value)
  }
  return relays.slice(0, 8)
}

export async function discoverWriteRelays(
  query: (relays: string[], filter: Filter) => Promise<Event[]>,
  pubkey: string,
  configured: string[],
  timeoutMs = 4000
): Promise<string[]> {
  const events = await withTimeout(
    query(configured, { kinds: [10002], authors: [pubkey], limit: 5 }),
    timeoutMs
  )
  const list = events
    .filter((event) => event.kind === 10002 && event.pubkey === pubkey && verifyEvent(event))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
  return list ? extractWriteRelays(list) : []
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NIP-65 lookup timed out')), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
