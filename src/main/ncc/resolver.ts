/**
 * NCC-05 resolver.
 *
 * Deliberately not built on `ncc-05-js`: that implementation queries kind 30058
 * without a `#d` filter, keeps only the author's single freshest event across all
 * `d` tags, and returns expired payloads under `strict: false`. All three break a
 * browser that addresses individual services on a multi-service identity.
 */

import { SimplePool, getPublicKey, nip19, nip44, verifyEvent, type Event, type Filter } from 'nostr-tools'
import {
  candidateDTags,
  dTagSource,
  normalizeEndpoints,
  payloadExpiry,
  parsePayload,
  sortEndpoints,
  type NccPayload
} from './locator'
import {
  DEFAULT_SERVICE,
  type ResolveFailure,
  type ResolveOutcome,
  type ResolvedService
} from '@shared/types'
import type { LocatorStore } from '../cache-store'

export interface LocatorSigner {
  getPublicKey(): Promise<string> | string
  getConversationKey(peerPubkey: string): Promise<Uint8Array> | Uint8Array
}

export type QueryFn = (relays: string[], filter: Filter) => Promise<Event[]>

export interface ResolverOptions {
  relays: () => string[]
  /** Injectable for tests and for swapping in a shared pool. */
  query?: QueryFn
  timeoutMs?: number
  now?: () => number
  signer?: LocatorSigner | null
  /** Resolved lazily, so an identity imported after startup is picked up. */
  getSigner?: () => LocatorSigner | null
  /** Upper bound on a positive cache entry, so rotations are noticed. */
  maxCacheSeconds?: number
  negativeCacheSeconds?: number
  /** Follow the target identity's NIP-65 relay list (kind 10002). */
  gossip?: () => boolean
  /** Optional on-disk cache for public records. */
  cacheStore?: LocatorStore
}

interface Cached {
  outcome: ResolveOutcome
  expiresAt: number
}

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_CACHE_SECONDS = 120
const DEFAULT_NEGATIVE_CACHE_SECONDS = 15
const MAX_EVENTS_PER_D = 10

let sharedPool: SimplePool | null = null

function getPool(): SimplePool {
  sharedPool ??= new SimplePool()
  return sharedPool
}

async function defaultQuery(relays: string[], filter: Filter): Promise<Event[]> {
  return getPool().querySync(relays, filter)
}

export function closeSharedPool(): void {
  if (sharedPool) {
    sharedPool.close([])
    sharedPool = null
  }
}

export function signerFromSecret(secret: Uint8Array): LocatorSigner {
  return {
    getPublicKey: () => getPublicKey(secret),
    getConversationKey: (peer: string) => nip44.getConversationKey(secret, peer)
  }
}

export function toHexPubkey(pubkey: string): string | null {
  const value = pubkey.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  if (!value.startsWith('npub1')) return null
  try {
    const decoded = nip19.decode(value)
    return decoded.type === 'npub' ? (decoded.data as string) : null
  } catch {
    return null
  }
}

function failure(code: ResolveFailure['code'], message: string, detail?: string): ResolveFailure {
  return { ok: false, code, message, detail }
}

interface Decoded {
  payload: NccPayload
  encrypted: boolean
}

type DecodeResult =
  | { ok: true; value: Decoded }
  | { ok: false; reason: 'undecryptable' | 'invalid' }

export class NccResolver {
  private readonly options: ResolverOptions
  private readonly query: QueryFn
  private readonly now: () => number
  private readonly cache = new Map<string, Cached>()
  private readonly inflight = new Map<string, Promise<ResolveOutcome>>()

  constructor(options: ResolverOptions) {
    this.options = options
    this.query = options.query ?? defaultQuery
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  async resolve(pubkey: string, service?: string | null): Promise<ResolveOutcome> {
    const hex = toHexPubkey(pubkey)
    if (!hex) {
      return failure('invalid-address', 'That pubkey is not a valid npub', pubkey)
    }

    const normalizedService = (service ?? '').trim() || DEFAULT_SERVICE
    const key = `${hex}:${normalizedService}`

    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.outcome
    if (cached) this.cache.delete(key)

    const persisted = this.options.cacheStore?.get(hex, normalizedService) ?? null
    if (persisted) {
      const ttl = Math.min(
        persisted.expiresAt - this.now(),
        this.options.maxCacheSeconds ?? DEFAULT_MAX_CACHE_SECONDS
      )
      if (ttl > 0) {
        const outcome: ResolveOutcome = { ok: true, record: persisted }
        this.cache.set(key, { outcome, expiresAt: this.now() + ttl })
        return outcome
      }
      this.options.cacheStore?.delete(hex, normalizedService)
    }

    const running = this.inflight.get(key)
    if (running) return running

    const promise = this.resolveUncached(pubkey, hex, normalizedService)
      .then((outcome) => {
        const ttl = outcome.ok
          ? Math.max(
              5,
              Math.min(
                outcome.record.expiresAt - this.now(),
                this.options.maxCacheSeconds ?? DEFAULT_MAX_CACHE_SECONDS
              )
            )
          : (this.options.negativeCacheSeconds ?? DEFAULT_NEGATIVE_CACHE_SECONDS)
        this.cache.set(key, { outcome, expiresAt: this.now() + ttl })
        return outcome
      })
      .finally(() => {
        this.inflight.delete(key)
      })

    this.inflight.set(key, promise)
    return promise
  }

  /** Drop all cached records (used after the relay list changes). */
  clearCache(): void {
    this.cache.clear()
  }

  private async resolveUncached(
    pubkey: string,
    hexPubkey: string,
    service: string
  ): Promise<ResolveOutcome> {
    const configured = [...new Set(this.options.relays().filter(Boolean))]
    if (configured.length === 0) {
      return failure('relay-error', 'No relays are configured')
    }

    const discovered = this.shouldGossip() ? await this.discoverRelays(hexPubkey, configured) : []
    const relays = [...new Set([...configured, ...discovered])]

    const candidates = candidateDTags(service)
    let events: Event[]
    try {
      events = await withTimeout(
        this.query(relays, {
          kinds: [30058],
          authors: [hexPubkey],
          '#d': candidates,
          limit: 50
        }),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'timeout') {
        return failure('timeout', 'Relays did not answer in time', relays.join(', '))
      }
      return failure('relay-error', 'Could not query relays', message)
    }

    const seen = new Set<string>()
    const byDTag = new Map<string, Event[]>()
    for (const event of events) {
      if (!event || seen.has(event.id)) continue
      seen.add(event.id)
      if (event.kind !== 30058) continue
      if (event.pubkey !== hexPubkey) continue
      if (!verifyEvent(event)) continue
      const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1]
      if (!dTag || !candidates.includes(dTag)) continue
      const bucket = byDTag.get(dTag) ?? []
      bucket.push(event)
      byDTag.set(dTag, bucket)
    }

    for (const bucket of byDTag.values()) {
      bucket.sort((a, b) => {
        if (b.created_at !== a.created_at) return b.created_at - a.created_at
        return a.id.localeCompare(b.id)
      })
    }

    const now = this.now()
    let sawUndecryptable = false
    let sawExpired = false
    let sawInvalid = false
    let sawNoEndpoint = false

    for (const dTag of candidates) {
      const bucket = byDTag.get(dTag)
      if (!bucket) continue

      for (const event of bucket.slice(0, MAX_EVENTS_PER_D)) {
        const decoded = await this.decode(event)
        if (!decoded.ok) {
          if (decoded.reason === 'undecryptable') sawUndecryptable = true
          else sawInvalid = true
          continue
        }

        const expirationTag = event.tags.find((tag) => tag[0] === 'expiration')?.[1]
        const expiresAt = payloadExpiry(decoded.value.payload, expirationTag)
        if (expiresAt <= now) {
          sawExpired = true
          continue
        }

        const endpoints = sortEndpoints(normalizeEndpoints(decoded.value.payload.endpoints))
        if (endpoints.length === 0) {
          sawNoEndpoint = true
          continue
        }

        const record: ResolvedService = {
          pubkey,
          hexPubkey,
          service,
          dTag,
          dTagSource: dTagSource(dTag, service),
          endpoints,
          expiresAt,
          updatedAt: decoded.value.payload.updated_at,
          eventId: event.id,
          encrypted: decoded.value.encrypted
        }

        if (!record.encrypted) this.options.cacheStore?.set(record)

        return { ok: true, record }
      }
    }

    if (sawUndecryptable) {
      return failure(
        'undecryptable',
        'The locator is encrypted and this browser cannot decrypt it',
        'Set NCC_LOCATOR_NSEC to read records addressed to you.'
      )
    }
    if (sawExpired) {
      return failure('expired', 'The locator record has expired', `Tried d=${candidates.join(', ')}`)
    }
    if (sawNoEndpoint) {
      return failure('no-endpoint', 'The locator has no fetchable endpoints')
    }
    if (sawInvalid) {
      return failure('invalid-payload', 'The locator payload is malformed')
    }
    return failure(
      'no-record',
      'No NCC-05 locator found for this service',
      `Tried d=${candidates.join(', ')} on ${relays.length} relay(s)`
    )
  }

  /** Follow the target's NIP-65 list, read-only entries only, capped and deduped. */
  private async discoverRelays(hexPubkey: string, configured: string[]): Promise<string[]> {
    try {
      const events = await withTimeout(
        this.query(configured, { kinds: [10002], authors: [hexPubkey], limit: 5 }),
        Math.min(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 4000)
      )

      const relayList = events
        .filter((event) => event.kind === 10002 && event.pubkey === hexPubkey && verifyEvent(event))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
      if (!relayList) return []

      const relays: string[] = []
      for (const tag of relayList.tags) {
        if (tag[0] !== 'r' || !tag[1]) continue
        if (tag[2] === 'write') continue // NCC-05 §2.1: read or both
        let url: URL
        try {
          url = new URL(tag[1])
        } catch {
          continue
        }
        if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue
        const value = tag[1].replace(/\/$/, '')
        if (!relays.includes(value) && !configured.includes(value)) relays.push(value)
      }
      return relays.slice(0, 8)
    } catch {
      // Gossip is a hint mechanism; its failure must not affect resolution.
      return []
    }
  }

  private shouldGossip(): boolean {
    try {
      return this.options.gossip?.() === true
    } catch {
      return false
    }
  }

  private async decode(event: Event): Promise<DecodeResult> {
    const content = event.content.trim()

    // Public records are plaintext JSON. A wrapped record also starts with `{`,
    // but has no endpoints, so it falls through as invalid in v0.1.
    if (content.startsWith('{')) {
      try {
        const payload = parsePayload(JSON.parse(content))
        return payload ? { ok: true, value: { payload, encrypted: false } } : { ok: false, reason: 'invalid' }
      } catch {
        return { ok: false, reason: 'invalid' }
      }
    }

    if (!this.currentSigner()) return { ok: false, reason: 'undecryptable' }

    try {
      const conversationKey = await (this.currentSigner() as LocatorSigner).getConversationKey(
        event.pubkey
      )
      const plaintext = nip44.decrypt(content, conversationKey)
      const payload = parsePayload(JSON.parse(plaintext))
      return payload ? { ok: true, value: { payload, encrypted: true } } : { ok: false, reason: 'invalid' }
    } catch {
      return { ok: false, reason: 'undecryptable' }
    }
  }

  private currentSigner(): LocatorSigner | null {
    const dynamic = this.options.getSigner?.()
    return dynamic ?? this.options.signer ?? null
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
