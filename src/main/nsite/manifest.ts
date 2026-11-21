/**
 * NIP-5A manifest parsing: validation, the path -> sha256 index, and the aggregate
 * hash. Pure functions only; relays and blobs live in resolver.ts and blob.ts.
 */

import { createHash } from 'node:crypto'
import { verifyEvent, type Event } from 'nostr-tools'
import { NSITE_NAMED_KIND, NSITE_ROOT_KIND } from '@shared/nsite-publish'

export { NSITE_NAMED_KIND, NSITE_ROOT_KIND }

const HASH_RE = /^[0-9a-f]{64}$/

export interface NsiteManifest {
  /** Hex pubkey of the author. */
  pubkey: string
  /** Named site id, or null for the root site. */
  site: string | null
  eventId: string
  updatedAt: number
  title: string | null
  description: string | null
  source: string | null
  servers: string[]
  /** Absolute path (starting with `/`) -> sha256 hex. */
  paths: Map<string, string>
  aggregate: string | null
  event: Event
}

export type ManifestResult =
  | { ok: true; manifest: NsiteManifest }
  | { ok: false; code: 'manifest-invalid'; message: string }

export function readManifest(event: Event, pubkey: string, site: string | null): ManifestResult {
  const expectedKind = site ? NSITE_NAMED_KIND : NSITE_ROOT_KIND
  if (event.kind !== expectedKind) {
    return invalid(`Expected kind ${expectedKind}`)
  }
  if (event.pubkey !== pubkey) return invalid('Manifest author does not match the address')
  if (!verifyEvent(event)) return invalid('Manifest signature is not valid')

  if (site) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
    if (d !== site) return invalid('Manifest d tag does not match the site id')
  }

  const paths = new Map<string, string>()
  for (const tag of event.tags) {
    if (tag[0] !== 'path') continue
    const path = String(tag[1] ?? '')
    const hash = String(tag[2] ?? '').toLowerCase()
    if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) continue
    if (!HASH_RE.test(hash)) continue
    if (!paths.has(path)) paths.set(path, hash)
  }
  if (paths.size === 0) return invalid('Manifest has no usable path entries')

  const servers = [
    ...new Set(
      event.tags
        .filter((tag) => tag[0] === 'server')
        .map((tag) => String(tag[1] ?? '').replace(/\/+$/, ''))
        .filter((url) => /^https?:\/\//i.test(url))
    )
  ].slice(0, 8)

  const computed = aggregateHash(paths)

  return {
    ok: true,
    manifest: {
      pubkey,
      site,
      eventId: event.id,
      updatedAt: event.created_at,
      title: tagValue(event, 'title'),
      description: tagValue(event, 'description'),
      source: tagValue(event, 'source'),
      servers,
      paths,
      // A wrong aggregate is metadata drift, not content corruption: the path hashes
      // are the binding, so publish the computed value rather than the declaration.
      aggregate: computed,
      event
    }
  }
}

/** sha256 over `"<hash> <path>\n"` lines, sorted ascending, as NIP-5A defines. */
export function aggregateHash(paths: Map<string, string>): string {
  const lines = [...paths.entries()]
    .map(([path, hash]) => `${hash} ${path}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('')
  return createHash('sha256').update(lines, 'utf8').digest('hex')
}

export type PathMatch =
  | { kind: 'file'; path: string; hash: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'missing' }

/** Resolve a request path against the manifest, following NIP-5A's index rules. */
export function matchPath(
  paths: Map<string, string>,
  requestPath: string,
  search = ''
): PathMatch {
  let path = requestPath
  try {
    path = decodeURIComponent(requestPath)
  } catch {
    return { kind: 'missing' }
  }
  if (!path.startsWith('/')) path = `/${path}`
  if (path.includes('\0') || path.split('/').includes('..')) return { kind: 'missing' }

  if (path.endsWith('/')) {
    const index = `${path}index.html`
    const hash = paths.get(index)
    return hash ? { kind: 'file', path: index, hash } : { kind: 'missing' }
  }

  const exact = paths.get(path)
  if (exact) return { kind: 'file', path, hash: exact }

  // A directory that has files under it should be addressed with a trailing slash so
  // relative links stay inside it.
  const prefix = `${path}/`
  for (const candidate of paths.keys()) {
    if (candidate.startsWith(prefix)) {
      return { kind: 'redirect', location: `${path}/${search}` }
    }
  }

  return { kind: 'missing' }
}

function tagValue(event: Event, name: string): string | null {
  const value = event.tags.find((tag) => tag[0] === name)?.[1]
  return value ? String(value) : null
}

function invalid(message: string): ManifestResult {
  return { ok: false, code: 'manifest-invalid', message }
}
