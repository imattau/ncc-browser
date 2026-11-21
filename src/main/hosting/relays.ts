/**
 * Relay selection and publishing for hosted services.
 *
 * A locator is published to the configured relays plus the owner's NIP-65 read and
 * write relays: the recipient's resolver queries its own relays and the author's
 * read-marked relays, so a share that only reached a write-only relay may never be
 * found.
 */

import { verifyEvent, type Event, type Filter } from 'nostr-tools'
import type { ConfigStore } from '../config'
import type { RelayPool } from '../relay/pool'
import type { HostingPublisher, PublishReport } from './service'

const MAX_RELAYS = 12
const PUBLISH_TIMEOUT_MS = 8_000

export class RelayHostingPublisher implements HostingPublisher {
  constructor(
    private readonly pool: RelayPool,
    private readonly config: ConfigStore
  ) {}

  async relaysFor(ownerHex: string): Promise<string[]> {
    const configured = this.config.getRelays()
    try {
      return await discoverPublishRelays(this.pool.query, ownerHex, configured)
    } catch {
      return configured
    }
  }

  async publish(event: Event, relays: string[]): Promise<PublishReport> {
    const unique = [...new Set(relays)].slice(0, MAX_RELAYS)
    const results = await Promise.all(
      unique.map(async (relay) => {
        try {
          await withTimeout(this.pool.publish(relay, event), PUBLISH_TIMEOUT_MS)
          return { relay, ok: true as const }
        } catch (error) {
          return { relay, ok: false as const, error: messageOf(error) }
        }
      })
    )
    const errors = results
      .filter((result): result is { relay: string; ok: false; error: string } => !result.ok)
      .map((result) => ({ relay: result.relay, error: result.error }))
    const accepted = results.length - errors.length
    return { ok: accepted > 0, accepted, relays: unique.length, errors }
  }
}

export async function discoverPublishRelays(
  query: (relays: string[], filter: Filter) => Promise<Event[]>,
  pubkey: string,
  configured: string[]
): Promise<string[]> {
  const events = await withTimeout(
    query(configured, { kinds: [10002], authors: [pubkey], limit: 5 }),
    4_000
  )
  const list = events
    .filter((event) => event.kind === 10002 && event.pubkey === pubkey && verifyEvent(event))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
  const discovered: string[] = []
  for (const tag of list?.tags ?? []) {
    if (tag[0] !== 'r' || !tag[1]) continue
    let url: URL
    try {
      url = new URL(tag[1])
    } catch {
      continue
    }
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue
    const value = tag[1].replace(/\/$/, '')
    if (!discovered.includes(value)) discovered.push(value)
  }
  return [...new Set([...configured, ...discovered])].slice(0, MAX_RELAYS)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay timed out')), timeoutMs)
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
