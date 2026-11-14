/**
 * NCC-02 service records (kind 30059) as the identity and trust anchor for NCC-05.
 *
 * NCC-02 publishes the service identity, an optional public endpoint (`u`), an optional
 * transport fingerprint (`k`) and an expiry (`exp`). NCC-05 keeps resolving the
 * reachable endpoint; this module decides whether the anchor exists, whether it is
 * fresh, and how its transport key relates to the NCC-05 endpoint keys.
 */

import { verifyEvent, type Event } from 'nostr-tools'
import type {
  AnchorInfo,
  AnchorKeyMatch,
  AnchorStatus,
  ResolvedEndpoint,
  ResolvedService,
  ServiceAnchor
} from '@shared/types'
import { normalizeEndpoints } from './locator'

export const ANCHOR_KIND = 30059
const MAX_ANCHORS_PER_D = 10

export type AnchorSelection =
  | { status: 'anchored'; anchor: ServiceAnchor }
  | { status: 'expired' | 'invalid' | 'none'; anchor: null }

export type AnchorParse =
  | { ok: true; anchor: ServiceAnchor }
  | { ok: false; reason: 'expired' | 'invalid' }

/**
 * Parse one kind 30059 event. `exp` is optional here for compatibility with early
 * publishers; when present it must be a positive unix timestamp and still be fresh.
 */
export function parseAnchorEvent(event: Event, authorHex: string, now: number): AnchorParse {
  if (!event || event.kind !== ANCHOR_KIND || event.pubkey !== authorHex) {
    return { ok: false, reason: 'invalid' }
  }
  if (!verifyEvent(event)) return { ok: false, reason: 'invalid' }

  const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1]?.trim()
  if (!dTag) return { ok: false, reason: 'invalid' }

  const expRaw = event.tags.find((tag) => tag[0] === 'exp')?.[1]
  let expiresAt = 0
  if (expRaw !== undefined) {
    const exp = Number(expRaw)
    if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'invalid' }
    if (exp <= now) return { ok: false, reason: 'expired' }
    expiresAt = exp
  }

  const rawEndpoint = event.tags.find((tag) => tag[0] === 'u')?.[1]?.trim() || null
  const endpoint = rawEndpoint
    ? (normalizeEndpoints([{ url: rawEndpoint }])[0]?.url ?? null)
    : null
  const k = event.tags.find((tag) => tag[0] === 'k')?.[1]?.trim() || null

  return {
    ok: true,
    anchor: {
      eventId: event.id,
      dTag,
      endpoint,
      rawEndpoint,
      k,
      expiresAt,
      updatedAt: event.created_at
    }
  }
}

/**
 * Pick the anchor for the requested service. Candidate order mirrors NCC-05, and
 * within a `d` tag the newest verifiable record wins; if that record is expired or
 * malformed, older records are considered but an expired exact record is reported
 * rather than silently falling back to a different namespace.
 */
export function selectAnchor(
  events: readonly Event[],
  authorHex: string,
  candidates: readonly string[],
  now: number
): AnchorSelection {
  const byDTag = new Map<string, Event[]>()
  for (const event of events) {
    if (!event || event.kind !== ANCHOR_KIND || event.pubkey !== authorHex) continue
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1]?.trim()
    if (!dTag || !candidates.includes(dTag)) continue
    const bucket = byDTag.get(dTag) ?? []
    bucket.push(event)
    byDTag.set(dTag, bucket)
  }

  for (const bucket of byDTag.values()) {
    bucket.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
  }

  for (const dTag of candidates) {
    const bucket = byDTag.get(dTag)
    if (!bucket) continue

    let expired = false
    let invalid = false
    for (const event of bucket.slice(0, MAX_ANCHORS_PER_D)) {
      const parsed = parseAnchorEvent(event, authorHex, now)
      if (parsed.ok) return { status: 'anchored', anchor: parsed.anchor }
      if (parsed.reason === 'expired') expired = true
      else invalid = true
    }
    return { status: expired ? 'expired' : invalid ? 'invalid' : 'none', anchor: null }
  }

  return { status: 'none', anchor: null }
}

export interface AnchorApplication {
  endpoints: ResolvedEndpoint[]
  kMatch: AnchorKeyMatch
  /** Endpoints dropped because NCC-02 and NCC-05 disagreed about the transport key. */
  conflicts: number
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function anchorApplies(anchor: ServiceAnchor, endpoint: ResolvedEndpoint): boolean {
  // A private service record has no `u`; its `k` is still the service's transport key.
  return anchor.endpoint ? sameOrigin(anchor.endpoint, endpoint.url) : true
}

/**
 * Attach the anchor to a resolved record. A missing endpoint `k` is filled from a
 * comparable NCC-02 `k`; a conflicting key on the same origin is dropped, and the
 * caller fails closed when no endpoint remains.
 */
export function applyAnchor(
  endpoints: readonly ResolvedEndpoint[],
  anchor: ServiceAnchor | null
): AnchorApplication {
  const out: ResolvedEndpoint[] = []
  let conflicts = 0
  let applied = false

  for (const endpoint of endpoints) {
    let k = endpoint.k
    let kSource: ResolvedEndpoint['kSource'] = endpoint.k ? 'ncc-05' : null
    let conflict = false

    if (anchor?.k && endpoint.protocol === 'https' && anchorApplies(anchor, endpoint)) {
      if (k) {
        if (k !== anchor.k) conflict = true
      } else {
        k = anchor.k
        kSource = 'ncc-02'
        applied = true
      }
    }

    if (conflict) {
      conflicts += 1
      continue
    }
    out.push({ ...endpoint, k, kSource })
  }

  let kMatch: AnchorKeyMatch = 'none'
  if (conflicts > 0) kMatch = 'mismatch'
  else if (anchor?.k) {
    const secure = endpoints.filter((endpoint) => endpoint.protocol === 'https')
    if (secure.some((endpoint) => endpoint.k === anchor.k)) kMatch = 'match'
    else if (applied) kMatch = 'anchor-only'
    else if (secure.some((endpoint) => endpoint.k)) kMatch = 'locator-only'
  } else if (endpoints.some((endpoint) => endpoint.protocol === 'https' && endpoint.k)) {
    kMatch = 'locator-only'
  }

  return { endpoints: out, kMatch, conflicts }
}

export function anchorInfo(
  selection: AnchorSelection,
  required: boolean,
  options: { fallback?: boolean; kMatch?: AnchorKeyMatch } = {}
): AnchorInfo {
  const status: AnchorStatus =
    selection.status === 'anchored'
      ? 'anchored'
      : selection.status === 'expired'
        ? 'expired'
        : selection.status === 'invalid'
          ? 'invalid'
          : required
            ? 'required-missing'
            : 'unanchored'

  return {
    status,
    record: selection.anchor,
    fallback: options.fallback === true,
    kMatch: options.kMatch ?? 'none',
    required
  }
}

/** Synthesise a record from the NCC-02 `u` endpoint when NCC-05 has no usable one. */
export function anchorFallbackRecord(
  base: Pick<ResolvedService, 'pubkey' | 'hexPubkey' | 'service'>,
  info: AnchorInfo,
  anchor: ServiceAnchor,
  now: number,
  maxCacheSeconds: number
): ResolvedService | null {
  if (!anchor.endpoint) return null
  const secure = anchor.endpoint.startsWith('https:')
  const endpoints = normalizeEndpoints([
    { url: anchor.endpoint, k: secure ? (anchor.k ?? undefined) : undefined }
  ])
  if (endpoints.length === 0) return null

  return {
    ...base,
    dTag: anchor.dTag,
    dTagSource:
      anchor.dTag === base.service
        ? 'exact'
        : anchor.dTag === `${base.service}-locator`
          ? 'locator-suffix'
          : 'default',
    endpoints: endpoints.map((endpoint) => ({
      ...endpoint,
      kSource: endpoint.k ? 'ncc-02' : null
    })),
    expiresAt: anchor.expiresAt > now ? anchor.expiresAt : now + maxCacheSeconds,
    updatedAt: anchor.updatedAt,
    eventId: anchor.eventId,
    encrypted: false,
    anchor: {
      ...info,
      fallback: true,
      kMatch: secure && anchor.k ? 'anchor-only' : 'none'
    }
  }
}
