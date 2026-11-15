/**
 * NCC-05 resolver.
 *
 * Deliberately not built on `ncc-05-js`: that implementation queries kind 30058
 * without a `#d` filter, keeps only the author's single freshest event across all
 * `d` tags, and returns expired payloads under `strict: false`. All three break a
 * browser that addresses individual services on a multi-service identity.
 *
 * Caching has two layers. The in-memory map answers repeated requests for a couple of
 * minutes. The optional on-disk store survives restarts, but it is a hint: a record is
 * only reused without a relay query while it is younger than `revalidateSeconds`.
 * Older entries are served immediately and refreshed in the background, so a publisher
 * can rotate its endpoint without the browser pinning the old one for the record's TTL.
 */

import { SimplePool, getPublicKey, nip19, nip44, verifyEvent, type Event, type Filter } from 'nostr-tools'
import {
  ANCHOR_KIND,
  anchorFallbackRecord,
  anchorInfo,
  applyAnchor,
  selectAnchor
} from './anchor'
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
  /** Optional: NIP-46 providers may skip this, since decryption is an RPC. */
  getPublicKey?(): Promise<string> | string
  /** Local keys can derive a conversation key directly. */
  getConversationKey?(peerPubkey: string): Promise<Uint8Array> | Uint8Array
  /** Remote signers decrypt NIP-44 payloads without exposing a key. */
  decrypt44?(peerPubkey: string, ciphertext: string): Promise<string> | string
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
  /** Upper bound on a positive in-memory cache entry. */
  maxCacheSeconds?: number
  negativeCacheSeconds?: number
  /** How long a persisted record may be reused before relays are asked again. */
  revalidateSeconds?: number
  /** Lifetime of a record synthesised from the NCC-02 `u` endpoint. */
  fallbackSeconds?: number
  /** Follow the target identity's NIP-65 relay list (kind 10002). */
  gossip?: () => boolean
  /** Refuse services without a fresh NCC-02 anchor (kind 30059). */
  anchorRequired?: () => boolean
  /** Optional on-disk cache for public records. */
  cacheStore?: LocatorStore
}

/** What the resolved endpoints will be used for. */
export type ResolveMode = 'web' | 'relay'

export interface ResolveOptions {
  /** `relay` accepts ws/wss endpoints; `web` (the default) never does. */
  mode?: ResolveMode
  /** Override the configured relay list, e.g. for bootstrap locator lookups. */
  relays?: string[]
}

interface Cached {
  outcome: ResolveOutcome
  expiresAt: number
}

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_CACHE_SECONDS = 120
const DEFAULT_NEGATIVE_CACHE_SECONDS = 15
const DEFAULT_REVALIDATE_SECONDS = 60
const DEFAULT_FALLBACK_SECONDS = 300
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

function cacheKey(hex: string, service: string, mode: ResolveMode): string {
  return `${hex}:${service}:${mode}`
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
  private readonly revalidating = new Map<string, Promise<void>>()
  /** Incremented by `clearCache`, so a slow query cannot repopulate a cleared cache. */
  private generation = 0

  constructor(options: ResolverOptions) {
    this.options = options
    this.query = options.query ?? defaultQuery
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  async resolve(
    pubkey: string,
    service?: string | null,
    options: ResolveOptions = {}
  ): Promise<ResolveOutcome> {
    const hex = toHexPubkey(pubkey)
    if (!hex) {
      return failure('invalid-address', 'That pubkey is not a valid npub', pubkey)
    }

    const mode: ResolveMode = options.mode === 'relay' ? 'relay' : 'web'
    const normalizedService = (service ?? '').trim() || DEFAULT_SERVICE
    const key = cacheKey(hex, normalizedService, mode)

    const now = this.now()
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > now) return cached.outcome
    if (cached) this.cache.delete(key)

    const requiresAnchor = this.shouldRequireAnchor()
    const persisted =
      mode === 'web' ? (this.options.cacheStore?.get(hex, normalizedService) ?? null) : null

    if (persisted) {
      const record = persisted.record
      const anchored = !requiresAnchor || record.anchor?.status === 'anchored'
      const anchorFresh = this.anchorIsFresh(record, now)

      if (record.expiresAt <= now || !anchored || (requiresAnchor && !anchorFresh)) {
        // Expired, written under a different anchoring policy, or backed by an anchor
        // whose own `exp` has passed: ask relays rather than trust the copy.
        this.options.cacheStore?.delete(hex, normalizedService)
      } else {
        const maxAge = this.options.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS
        const anchorStale = record.anchor?.record ? !anchorFresh : false
        const stale = anchorStale || now - persisted.validatedAt > maxAge
        const outcome = this.withStale(record, stale)
        const ttl = Math.max(
          1,
          Math.min(record.expiresAt - now, this.options.maxCacheSeconds ?? DEFAULT_MAX_CACHE_SECONDS)
        )
        this.cache.set(key, { outcome, expiresAt: now + ttl })
        // Serve the known-good endpoint now, and confirm it against relays in the
        // background. The next request (or tab reload) sees any rotation.
        if (stale) this.revalidateInBackground(pubkey, hex, normalizedService, mode)
        return outcome
      }
    }

    return this.queryAndCache(pubkey, hex, normalizedService, mode, options.relays)
  }

  /**
   * Drop one resolved service from both cache layers. Used when its endpoints stop
   * accepting connections and by the site panel's "Re-resolve" action.
   */
  invalidate(pubkey: string, service?: string | null, mode: ResolveMode = 'web'): void {
    const hex = toHexPubkey(pubkey)
    if (!hex) return
    const normalizedService = (service ?? '').trim() || DEFAULT_SERVICE
    this.cache.delete(cacheKey(hex, normalizedService, mode))
    if (mode === 'web') this.options.cacheStore?.delete(hex, normalizedService)
  }

  /** Drop all cached records (used after the relay list changes). */
  clearCache(): void {
    this.generation += 1
    this.cache.clear()
  }

  /** Wait for background revalidations; used by tests and shutdown. */
  async settle(): Promise<void> {
    while (this.revalidating.size > 0) {
      await Promise.allSettled([...this.revalidating.values()])
    }
  }

  /**
   * Query relays and cache the outcome. Failures are cached briefly, except during a
   * background revalidation, where an existing copy must stay usable.
   */
  private queryAndCache(
    pubkey: string,
    hex: string,
    service: string,
    mode: ResolveMode,
    relays?: string[],
    keepOnFailure = false
  ): Promise<ResolveOutcome> {
    const key = cacheKey(hex, service, mode)
    const running = this.inflight.get(key)
    if (running) return running

    const generation = this.generation
    const promise = this.resolveUncached(pubkey, hex, service, mode, relays)
      .then((outcome) => {
        if (outcome.ok && mode === 'web' && !outcome.record.encrypted) {
          if (this.generation === generation) this.options.cacheStore?.set(outcome.record)
        }

        if (!outcome.ok && keepOnFailure) {
          // Relays did not confirm the copy we already have. Keep serving it until it
          // expires; the next request will try the relays again.
          const previous = this.cache.get(key)
          if (previous?.outcome.ok) {
            this.cache.set(key, {
              outcome: this.withStale(previous.outcome.record, true),
              expiresAt: previous.expiresAt
            })
            return outcome
          }
        }

        const normalized = outcome.ok ? this.withStale(outcome.record, false) : outcome
        if (this.generation === generation) {
          this.cache.set(key, {
            outcome: normalized,
            expiresAt: this.now() + this.ttlFor(normalized)
          })
        }
        return normalized
      })
      .finally(() => {
        this.inflight.delete(key)
      })

    this.inflight.set(key, promise)
    return promise
  }

  /** Confirm a persisted record against relays without blocking the caller. */
  private revalidateInBackground(
    pubkey: string,
    hex: string,
    service: string,
    mode: ResolveMode
  ): void {
    const key = cacheKey(hex, service, mode)
    if (this.revalidating.has(key)) return

    const task = this.queryAndCache(pubkey, hex, service, mode, undefined, true)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.revalidating.delete(key)
      })

    this.revalidating.set(key, task)
  }

  private ttlFor(outcome: ResolveOutcome): number {
    if (!outcome.ok) return this.options.negativeCacheSeconds ?? DEFAULT_NEGATIVE_CACHE_SECONDS
    return Math.max(
      1,
      Math.min(
        outcome.record.expiresAt - this.now(),
        this.options.maxCacheSeconds ?? DEFAULT_MAX_CACHE_SECONDS
      )
    )
  }

  /** Copy a record for the caller, with the current anchoring policy and staleness. */
  private withStale(record: ResolvedService, stale: boolean): ResolveOutcome {
    const required = this.shouldRequireAnchor()
    const anchor = record.anchor ? { ...record.anchor, required } : undefined
    const { stale: _previous, ...rest } = record
    return {
      ok: true,
      record: {
        ...rest,
        ...(anchor ? { anchor } : {}),
        ...(stale ? { stale: true } : {})
      }
    }
  }

  /** True when the record's anchor carries no `exp`, or its `exp` is still ahead. */
  private anchorIsFresh(record: ResolvedService, now: number): boolean {
    const anchor = record.anchor?.record
    if (!anchor) return false
    return anchor.expiresAt === 0 || anchor.expiresAt > now
  }

  private async resolveUncached(
    pubkey: string,
    hexPubkey: string,
    service: string,
    mode: ResolveMode = 'web',
    relaysOverride?: string[]
  ): Promise<ResolveOutcome> {
    const configured = [
      ...new Set((relaysOverride ?? this.options.relays()).filter(Boolean))
    ]
    if (configured.length === 0) {
      return failure('relay-error', 'No relays are configured')
    }

    const discovered = this.shouldGossip() ? await this.discoverRelays(hexPubkey, configured) : []
    const relays = [...new Set([...configured, ...discovered])]

    const candidates = candidateDTags(service)
    const required = this.shouldRequireAnchor()
    let events: Event[]
    try {
      events = await withTimeout(
        this.query(relays, {
          kinds: [30058, ANCHOR_KIND],
          authors: [hexPubkey],
          '#d': candidates,
          limit: 80
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

    const now = this.now()
    const anchorSelection = selectAnchor(events, hexPubkey, candidates, now)
    const baseAnchor = anchorInfo(anchorSelection, required)

    if (required && anchorSelection.status !== 'anchored') {
      const code =
        anchorSelection.status === 'expired'
          ? 'anchor-expired'
          : anchorSelection.status === 'invalid'
            ? 'anchor-invalid'
            : 'no-anchor'
      return failure(
        code,
        code === 'no-anchor'
          ? 'Anchored mode requires a fresh NCC-02 service record'
          : code === 'anchor-expired'
            ? 'The NCC-02 service record has expired'
            : 'The NCC-02 service record is invalid',
        `Tried kind ${ANCHOR_KIND} for d=${candidates.join(', ')}`
      )
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

    let sawUndecryptable = false
    let sawExpired = false
    let sawInvalid = false
    let sawNoEndpoint = false
    let record: ResolvedService | null = null

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

        const endpoints = sortEndpoints(
          normalizeEndpoints(decoded.value.payload.endpoints, { allowWs: mode === 'relay' })
        )
        if (endpoints.length === 0) {
          sawNoEndpoint = true
          continue
        }

        record = {
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
        break
      }
      if (record) break
    }

    if (record) {
      const applied = applyAnchor(record.endpoints, anchorSelection.anchor)
      if (applied.endpoints.length === 0 && applied.conflicts > 0) {
        return failure(
          'anchor-k-mismatch',
          'The NCC-02 and NCC-05 transport fingerprints conflict',
          `Anchor ${anchorSelection.anchor?.eventId ?? ''}`
        )
      }

      record.endpoints = applied.endpoints
      record.anchor = { ...baseAnchor, kMatch: applied.kMatch }
      return { ok: true, record }
    }

    // NCC-02 anchoring allows the service record's public `u` endpoint to work when
    // NCC-05 has no usable locator (NCC-05 §7 fallback). A relay entry needs ws(s),
    // which the `u` fallback cannot provide.
    if (
      mode === 'web' &&
      anchorSelection.status === 'anchored' &&
      anchorSelection.anchor.endpoint
    ) {
      const fallback = anchorFallbackRecord(
        { pubkey, hexPubkey, service },
        baseAnchor,
        anchorSelection.anchor,
        now,
        this.options.fallbackSeconds ?? DEFAULT_FALLBACK_SECONDS
      )
      if (fallback) return { ok: true, record: fallback }
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
      return failure(
        'no-endpoint',
        mode === 'relay'
          ? 'The locator publishes no ws:// or wss:// endpoint'
          : 'The locator has no fetchable endpoints'
      )
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

  private shouldRequireAnchor(): boolean {
    try {
      return this.options.anchorRequired?.() === true
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

    const signer = this.currentSigner()
    if (!signer) return { ok: false, reason: 'undecryptable' }

    try {
      let plaintext: string
      if (signer.decrypt44) {
        plaintext = await signer.decrypt44(event.pubkey, content)
      } else if (signer.getConversationKey) {
        plaintext = nip44.decrypt(content, await signer.getConversationKey(event.pubkey))
      } else {
        return { ok: false, reason: 'undecryptable' }
      }
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
