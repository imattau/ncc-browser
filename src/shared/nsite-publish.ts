/**
 * NIP-5A site manifest construction, shared by the native publisher, the bundled
 * standalone publisher and the tests.
 *
 * A manifest is one event listing every file by path and sha256, plus the Blossom
 * servers that hold the bytes. Nothing here touches the filesystem, the network or a
 * signer beyond the `signEvent` call, so it is safe in the renderer and in Node.
 */

import { nip19, verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import { buildNsiteUrl, isValidSiteId } from './nsite-url'

export const NSITE_ROOT_KIND = 15128
export const NSITE_NAMED_KIND = 35128

export const MAX_NSITE_FILE_BYTES = 25 * 1024 * 1024
export const MAX_NSITE_TOTAL_BYTES = 512 * 1024 * 1024

export interface NsiteSiteFile {
  /** Absolute path starting with `/`, the manifest's addressing key. */
  path: string
  /** Lowercase sha256 hex. */
  hash: string
  size: number
}

export interface NsiteManifestDraft {
  /** Named site id, or null for the author's root site. */
  siteId: string | null
  title?: string
  description?: string
  source?: string
  files: NsiteSiteFile[]
  servers: string[]
}

export interface NsiteManifestSigner {
  signEvent(template: EventTemplate): Promise<Event>
}

const HASH_RE = /^[0-9a-f]{64}$/

export function validateNsiteSiteId(siteId: string | null): string | null {
  if (siteId === null || siteId === '') return null
  if (!isValidSiteId(siteId)) {
    return 'Use 1–13 characters: lowercase letters, digits and dashes, not ending in a dash.'
  }
  return null
}

/** File-level validation, including the browser's own fetch limits. */
export function validateNsiteFiles(files: NsiteSiteFile[]): string[] {
  const problems: string[] = []
  if (files.length === 0) return ['Choose a built site folder first.']
  if (!files.some((file) => file.path === '/index.html')) {
    problems.push('The folder has no /index.html at its root, so the site has no entry page.')
  }
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    if (!file.path.startsWith('/')) problems.push(`${file.path} is not an absolute path.`)
    if (file.path.includes('\0') || file.path.split('/').includes('..')) {
      problems.push(`${file.path} contains an illegal path segment.`)
    }
    if (seen.has(file.path)) problems.push(`${file.path} appears twice.`)
    seen.add(file.path)
    if (!HASH_RE.test(file.hash)) problems.push(`${file.path} does not have a valid sha256.`)
    if (!Number.isFinite(file.size) || file.size < 0) problems.push(`${file.path} has no size.`)
    if (file.size > MAX_NSITE_FILE_BYTES) {
      problems.push(`${file.path} is larger than ${MAX_NSITE_FILE_BYTES / (1024 * 1024)} MB.`)
    }
    total += file.size
  }
  if (total > MAX_NSITE_TOTAL_BYTES) {
    problems.push(`The site is larger than ${MAX_NSITE_TOTAL_BYTES / (1024 * 1024)} MB.`)
  }
  return problems
}

export function normalizeNsiteServers(servers: string[]): string[] {
  return [
    ...new Set(
      servers
        .map((server) => server.trim().replace(/\/+$/, ''))
        .filter((server) => /^https?:\/\//i.test(server))
    )
  ].slice(0, 8)
}

export function buildNsiteManifestTags(draft: NsiteManifestDraft): string[][] {
  const tags: string[][] = []
  if (draft.siteId) tags.push(['d', draft.siteId])
  if (draft.title?.trim()) tags.push(['title', draft.title.trim()])
  if (draft.description?.trim()) tags.push(['description', draft.description.trim()])
  if (draft.source?.trim()) tags.push(['source', draft.source.trim()])
  for (const file of draft.files) tags.push(['path', file.path, file.hash])
  for (const server of normalizeNsiteServers(draft.servers)) tags.push(['server', server])
  return tags
}

export async function signNsiteManifest(
  draft: NsiteManifestDraft,
  signer: NsiteManifestSigner,
  createdAt = Math.floor(Date.now() / 1000)
): Promise<Event> {
  const siteIdError = validateNsiteSiteId(draft.siteId)
  if (siteIdError) throw new Error(siteIdError)
  const fileProblems = validateNsiteFiles(draft.files)
  if (fileProblems.length > 0) throw new Error(fileProblems.join(' '))
  const servers = normalizeNsiteServers(draft.servers)
  if (servers.length === 0) throw new Error('Add at least one Blossom server.')

  const event = await signer.signEvent({
    kind: draft.siteId ? NSITE_NAMED_KIND : NSITE_ROOT_KIND,
    created_at: createdAt,
    tags: buildNsiteManifestTags({ ...draft, servers }),
    content: ''
  })
  if (!verifyEvent(event)) throw new Error('The signer returned an invalid manifest signature.')
  return event
}

export function nsiteSiteAddress(pubkey: string, siteId: string | null): string {
  try {
    return buildNsiteUrl({ pubkey: nip19.npubEncode(pubkey), site: siteId || null })
  } catch {
    return buildNsiteUrl({ pubkey, site: siteId || null })
  }
}

export interface PublishedNsite {
  id: string
  /** Hex pubkey of the identity that signed the current manifest. */
  owner: string
  /** Named site id, or null for the root site. */
  siteId: string | null
  title?: string
  description?: string
  source?: string
  servers: string[]
  files: NsiteSiteFile[]
  manifestEventId: string
  createdAt: number
  updatedAt: number
  lastPublishedAt?: number
  lastPublishError?: string
}

export interface NsitePublishState {
  version: 1
  sites: PublishedNsite[]
}

export interface NsiteFolderScan {
  /** Main-process handle for the scanned folder; the renderer never gets a path. */
  token: string
  folderName: string
  files: NsiteSiteFile[]
  totalBytes: number
  problems: string[]
}

export interface NsitePublishInput {
  token: string
  siteId: string | null
  title: string
  description: string
  source: string
  servers: string[]
  relays: string[]
}

export interface NsiteRelayReport {
  relay: string
  ok: boolean
  message: string
}

export interface NsitePublishResult {
  site: PublishedNsite
  address: string
  reports: NsiteRelayReport[]
}

export interface NsiteVerifyResult {
  id: string
  checked: number
  missing: string[]
}

export interface NsiteProgress {
  phase: 'uploading' | 'publishing' | 'verifying'
  done: number
  total: number
  label: string
  log?: string
}

