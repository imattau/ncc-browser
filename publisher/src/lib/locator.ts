/**
 * Pure event construction for the publishing flow. No window, network or signer access,
 * so the payload rules can be exercised by unit tests and reused by any UI.
 */

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net'
]

export const DEFAULT_SERVICE = 'web'
export const DEFAULT_TTL_SECONDS = 600
export const DEFAULT_ANCHOR_DAYS = 14
export const DEFAULT_PRIORITY = 1000

export type EndpointScheme = 'http' | 'https' | 'ws' | 'wss' | 'onion'
export type EndpointFamily = '' | 'ipv4' | 'ipv6' | 'onion'

export interface EndpointDraft {
  scheme: EndpointScheme
  host: string
  port: string
  path: string
  priority: number
  family: EndpointFamily
  k: string
}

export interface PublisherDraft {
  service: string
  ttl: number
  endpoints: EndpointDraft[]
  relays: string[]
  encrypt: boolean
  publishAnchor: boolean
  anchorDays: number
  notes: string
}

export interface EventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface LocatorPayload {
  v: 1
  ttl: number
  updated_at: number
  endpoints: Array<{
    url: string
    priority: number
    family?: string
    k?: string
  }>
  notes?: string
}

export function newEndpoint(overrides: Partial<EndpointDraft> = {}): EndpointDraft {
  return {
    scheme: 'http',
    host: '127.0.0.1',
    port: '8080',
    path: '',
    priority: DEFAULT_PRIORITY,
    family: 'ipv4',
    k: '',
    ...overrides
  }
}

function normaliseHost(host: string): string {
  const value = host.trim().replace(/\/+$/, '')
  if (value.includes(':') && !value.startsWith('[') && !value.includes('://')) {
    return `[${value}]`
  }
  return value
}

/** Build a fetchable URL from the host/port helper fields. */
export function endpointUrl(endpoint: EndpointDraft): string {
  const host = normaliseHost(endpoint.host)
  const port = endpoint.port.trim()
  const path = endpoint.path.trim()
  const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
  return `${endpoint.scheme}://${host}${port ? `:${port}` : ''}${suffix}`
}

export function buildLocatorPayload(draft: PublisherDraft, now: number): LocatorPayload {
  const endpoints = draft.endpoints.map((endpoint) => {
    const item: LocatorPayload['endpoints'][number] = {
      url: endpointUrl(endpoint),
      priority: Number.isFinite(endpoint.priority) ? endpoint.priority : DEFAULT_PRIORITY
    }
    if (endpoint.family) item.family = endpoint.family
    if (endpoint.k.trim()) item.k = endpoint.k.trim()
    return item
  })

  const payload: LocatorPayload = {
    v: 1,
    ttl: Math.max(1, Math.round(draft.ttl)),
    updated_at: now,
    endpoints
  }
  if (draft.notes.trim()) payload.notes = draft.notes.trim()
  return payload
}

export function buildLocatorContent(draft: PublisherDraft, now: number): string {
  return JSON.stringify(buildLocatorPayload(draft, now), null, 2)
}

/**
 * NCC-05 kind 30058 template. `content` is either the plaintext payload or its
 * NIP-44 ciphertext; `encrypted` only controls the `private` tag.
 */
export function buildLocatorTemplate(
  draft: PublisherDraft,
  content: string,
  now: number
): EventTemplate {
  const tags: string[][] = [
    ['d', draft.service.trim()],
    ['expiration', String(now + Math.max(1, Math.round(draft.ttl)))]
  ]
  if (draft.encrypt) tags.push(['private', 'true'])

  return {
    kind: 30058,
    created_at: now,
    tags,
    content
  }
}

/**
 * NCC-02 kind 30059 template. It carries the public endpoint and transport key when
 * one is available; private services may omit `u` by leaving the first endpoint blank.
 */
export function buildAnchorTemplate(draft: PublisherDraft, now: number): EventTemplate | null {
  if (!draft.publishAnchor) return null
  const primary = draft.endpoints[0]
  if (!primary) return null

  const url = endpointUrl(primary)
  const tags: string[][] = [
    ['d', draft.service.trim()],
    ['exp', String(now + Math.max(1, Math.round(draft.anchorDays)) * 86_400)]
  ]
  if (url) tags.push(['u', url])
  if (primary.k.trim()) tags.push(['k', primary.k.trim()])

  return { kind: 30059, created_at: now, tags, content: '' }
}

export function buildNccAddress(npub: string, service: string): string {
  const name = service.trim() || DEFAULT_SERVICE
  return `ncc://${npub}/${name}`
}

export function parseRelayList(input: string): string[] {
  const relays: string[] = []
  for (const line of input.split(/\s+/)) {
    const value = line.trim().replace(/\/+$/, '')
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue
      if (!relays.includes(value)) relays.push(value)
    } catch {
      // ignore malformed relay URLs
    }
  }
  return relays.slice(0, 20)
}

export function validateDraft(draft: PublisherDraft): string[] {
  const errors: string[] = []
  const service = draft.service.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(service)) {
    errors.push('Service id must be 1–100 characters: letters, digits, dot, underscore, colon or dash.')
  }
  if (!Number.isFinite(draft.ttl) || draft.ttl < 60 || draft.ttl > 2_592_000) {
    errors.push('TTL must be between 60 seconds and 30 days.')
  }
  if (draft.publishAnchor && (!Number.isFinite(draft.anchorDays) || draft.anchorDays < 1 || draft.anchorDays > 365)) {
    errors.push('NCC-02 expiry must be between 1 and 365 days.')
  }
  if (draft.endpoints.length === 0) errors.push('Add at least one endpoint.')
  if (draft.relays.length === 0) errors.push('Add at least one ws:// or wss:// relay.')

  draft.endpoints.forEach((endpoint, index) => {
    const label = `Endpoint ${index + 1}`
    if (!endpoint.host.trim()) errors.push(`${label}: host is required.`)
    const port = endpoint.port.trim()
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      errors.push(`${label}: port must be between 1 and 65535.`)
    }
    if (!Number.isFinite(endpoint.priority) || endpoint.priority < 0) {
      errors.push(`${label}: priority must be zero or greater.`)
    }
  })

  return errors
}
