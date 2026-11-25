/**
 * Pure event construction for hosted services and private shares. No window, network
 * or signer access, so the same code runs in the browser, the main process, the
 * publisher app and the tests.
 */

import type {
  HostedService,
  HostingPayload,
  NccEventTemplate,
  ServiceEndpoint
} from './hosting'

export const ANCHOR_KIND = 30059
export const LOCATOR_KIND = 30058

export function buildLocatorPayload(
  endpoints: ServiceEndpoint[],
  ttlSeconds: number,
  now: number,
  notes?: string
): HostingPayload {
  const payload: HostingPayload = {
    v: 1,
    ttl: Math.max(1, Math.round(ttlSeconds)),
    updated_at: now,
    endpoints: endpoints.map((endpoint) => ({
      url: endpoint.url,
      priority: endpoint.priority,
      ...(endpoint.family ? { family: endpoint.family } : {}),
      ...(endpoint.k ? { k: endpoint.k } : {})
    }))
  }
  if (notes?.trim()) payload.notes = notes.trim()
  return payload
}

export function locatorContent(payload: HostingPayload): string {
  return JSON.stringify(payload)
}

export interface LocatorTemplateInput {
  dTag: string
  ttlSeconds: number
  content: string
  now: number
  privateTag: boolean
  /** Share records use their own fixed expiry instead of `now + ttl`. */
  expiresAt?: number
}

export function buildLocatorTemplate(input: LocatorTemplateInput): NccEventTemplate {
  const expiresAt = input.expiresAt ?? input.now + Math.max(1, Math.round(input.ttlSeconds))
  const tags: string[][] = [
    ['d', input.dTag],
    ['expiration', String(Math.floor(expiresAt))]
  ]
  if (input.privateTag) tags.push(['private', 'true'])
  return {
    kind: LOCATOR_KIND,
    created_at: input.now,
    tags,
    content: input.content
  }
}

export interface AnchorTemplateInput {
  service: string
  endpoint: ServiceEndpoint | undefined
  days: number
  now: number
  /** NCC-02 private mode: publish only d/exp, never the endpoint `u` or its key `k`. */
  privateMode?: boolean
}

/**
 * NCC-02 service record. It carries the public endpoint and transport key, so it is
 * only built for a public HTTPS endpoint; a private service must not leak its address.
 */
export function buildAnchorTemplate(input: AnchorTemplateInput): NccEventTemplate | null {
  const endpoint = input.endpoint
  const expiresAt = String(Math.floor(input.now + Math.max(1, input.days) * 86_400))

  // NCC-02 private/invite-only mode: a valid Service Record may omit `u`; NCC-05 is
  // then the exclusive endpoint source. `k` is left out too: it is readable by anyone,
  // so it would link records together and could be matched against servers found by
  // scanning the internet. The encrypted locator carries it instead.
  if (input.privateMode) {
    const tags: string[][] = [
      ['d', input.service],
      ['exp', expiresAt]
    ]
    return { kind: ANCHOR_KIND, created_at: input.now, tags, content: '' }
  }

  if (!endpoint || !endpoint.url.startsWith('https://')) return null
  // An onion address in a public anchor defeats the point of the onion endpoint.
  if (endpoint.family === 'onion') return null
  const tags: string[][] = [
    ['d', input.service],
    ['u', endpoint.url],
    ['exp', expiresAt]
  ]
  if (endpoint.k) tags.push(['k', endpoint.k])
  return {
    kind: ANCHOR_KIND,
    created_at: input.now,
    tags,
    content: ''
  }
}

/**
 * Replaces a share with an expired, endpoint-less record. The resolver selects the
 * newest event per `d` tag, so this is the best-effort revocation; the service itself
 * must rotate its endpoint for a hard cut-off.
 */
export function buildTombstoneTemplate(
  dTag: string,
  now: number,
  expiresAt = now - 1
): NccEventTemplate {
  return {
    kind: LOCATOR_KIND,
    created_at: now,
    tags: [
      ['d', dTag],
      ['expiration', String(Math.floor(expiresAt))]
    ],
    content: JSON.stringify({
      v: 1,
      ttl: 1,
      updated_at: now,
      endpoints: []
    })
  }
}

/** The payload a share publishes: same endpoints, but its own lifetime. */
export function sharePayload(
  service: HostedService,
  expiresAt: number,
  now: number
): HostingPayload {
  const ttl = Math.max(1, Math.floor(expiresAt - now))
  return buildLocatorPayload(service.endpoints, ttl, now, service.notes)
}
