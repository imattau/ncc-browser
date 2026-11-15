/**
 * NIP-5A manifest resolution against relays.
 *
 * Same shape as the NCC locator resolver: query, verify, cache briefly, and serve the
 * cached copy while confirming it in the background. A manifest is replaceable
 * (15128) or addressable (35128), so the newest `created_at` wins.
 */

import type { Event, Filter } from 'nostr-tools'
import { toHexPubkey } from '../ncc/resolver'
import { NSITE_NAMED_KIND, NSITE_ROOT_KIND, readManifest, type NsiteManifest } from './manifest'

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_TTL_SECONDS = 60

export type NsiteOutcome =
  | { ok: true; manifest: NsiteManifest; stale: boolean }
  | { ok: false; code: 'no-manifest' | 'manifest-invalid' | 'timeout' | 'relay-error'; message: string; detail?: string }

export interface NsiteResolverOptions {
  query: (relays: string[], filter: Filter) => Promise<Event[]>
  relays: () => string[]
  timeoutMs?: number
  ttlSeconds?: number
  now?: () => number
}

interface Cached {
  manifest: NsiteManifest
  expiresAt: number
}

export class NsiteResolver {
  private readonly cache = new Map<string, Cached>()
  private readonly inflight = new Map<string, Promise<NsiteOutcome>>()
  private generation = 0

  constructor(private readonly options: NsiteResolverOptions) {}

  async resolve(pubkey: string, site: string | null): Promise<NsiteOutcome> {
    const key = `${pubkey}:${site ?? ''}`
    const now = this.now()
    const cached = this.cache.get(key)
    if (cached) {
      if (cached.expiresAt > now) return { ok: true, manifest: cached.manifest, stale: false }
      // Serve the known copy and confirm it in the background; a relay hiccup must not
      // blank a working page.
      void this.refresh(pubkey, site, key).catch(() => undefined)
      return { ok: true, manifest: cached.manifest, stale: true }
    }
    return this.query(pubkey, site, key)
  }

  invalidate(pubkey: string, site: string | null): void {
    this.cache.delete(`${pubkey}:${site ?? ''}`)
  }

  clearCache(): void {
    this.generation += 1
    this.cache.clear()
  }

  private refresh(pubkey: string, site: string | null, key: string): Promise<NsiteOutcome> {
    return this.query(pubkey, site, key)
  }

  private query(pubkey: string, site: string | null, key: string): Promise<NsiteOutcome> {
    const running = this.inflight.get(key)
    if (running) return running

    const generation = this.generation
    const promise = this.fetch(pubkey, site)
      .then((outcome) => {
        if (outcome.ok && this.generation === generation) {
          this.cache.set(key, {
            manifest: outcome.manifest,
            expiresAt: this.now() + (this.options.ttlSeconds ?? DEFAULT_TTL_SECONDS)
          })
        }
        return outcome
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key)
      })

    this.inflight.set(key, promise)
    return promise
  }

  private async fetch(pubkey: string, site: string | null): Promise<NsiteOutcome> {
    const hex = toHexPubkey(pubkey)
    if (!hex) return { ok: false, code: 'manifest-invalid', message: 'Invalid pubkey' }
    const relays = [...new Set(this.options.relays().filter(Boolean))]
    if (relays.length === 0) {
      return { ok: false, code: 'relay-error', message: 'No relays are configured' }
    }

    const debug = process.env.NCC_NSITE_DEBUG === '1'
    const filter: Filter = site
      ? { kinds: [NSITE_NAMED_KIND], authors: [hex], '#d': [site], limit: 5 }
      : { kinds: [NSITE_ROOT_KIND], authors: [hex], limit: 5 }

    if (debug) console.log('[nsite] query', JSON.stringify({ relays, filter }))
    let events: Event[]
    try {
      events = await withTimeout(this.options.query(relays, filter), this.timeoutMs())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        code: message === 'timeout' ? 'timeout' : 'relay-error',
        message: message === 'timeout' ? 'Relays did not answer in time' : 'Could not query relays',
        detail: message
      }
    }

    if (debug) console.log('[nsite] events', events?.length ?? 0)
    const candidates = events
      .filter((event) => event.kind === (site ? NSITE_NAMED_KIND : NSITE_ROOT_KIND))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))

    let invalidMessage: string | null = null
    for (const event of candidates.slice(0, 5)) {
      const result = readManifest(event, hex, site)
      if (result.ok) return { ok: true, manifest: result.manifest, stale: false }
      invalidMessage ??= result.message
    }

    if (invalidMessage) {
      return { ok: false, code: 'manifest-invalid', message: invalidMessage }
    }
    return {
      ok: false,
      code: 'no-manifest',
      message: site ? `No site published under "${site}"` : 'No root site published'
    }
  }

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
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
