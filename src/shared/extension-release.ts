/**
 * Verification rules for extensions distributed with npack: which signed events make
 * an installable release. Pure: no network, filesystem or Electron.
 *
 * Mirrors npack's package protocol v1 (docs/package-protocol-v1.md in npack).
 */

import { nip19, verifyEvent, type Event } from 'nostr-tools'

export const RELEASE_KIND = 9900
export const REVOCATION_KIND = 9901
export const ARTIFACT_KIND = 1063
export const BLOSSOM_LIST_KIND = 10063
export const EXTENSION_ARTIFACT_KIND = 'navigator-extension'
const MAX_DOWNLOAD_URLS = 8

export type ReleaseReference =
  | { type: 'package'; publisher: string; name: string }
  | { type: 'event'; id: string; relays: string[] }

export interface ExtensionRelease {
  id: string
  publisher: string
  name: string
  version: string
  sha256: string
  artifactEventId: string
  createdAt: number
}

export type RevocableRelease = Pick<
  ExtensionRelease,
  'id' | 'publisher' | 'name' | 'version' | 'sha256'
>

const HEX64 = /^[0-9a-f]{64}$/
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Accepts `npub…/name`, `hex/name`, an `nevent`, a `note` or a hex event id. */
export function parseReleaseReference(input: string): ReleaseReference {
  const value = input.trim().replace(/^nostr:/i, '')
  const slash = value.indexOf('/')
  if (slash >= 0) {
    const publisher = publicKeyHex(value.slice(0, slash))
    const name = value.slice(slash + 1)
    if (publisher && isPackageName(name)) return { type: 'package', publisher, name }
  } else if (HEX64.test(value)) {
    return { type: 'event', id: value, relays: [] }
  } else {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type === 'note') return { type: 'event', id: decoded.data, relays: [] }
      if (decoded.type === 'nevent') {
        return { type: 'event', id: decoded.data.id, relays: decoded.data.relays ?? [] }
      }
    } catch {
      // Falls through to the message below.
    }
  }
  throw new Error('Enter publisher/name (such as npub1…/my-extension) or an nevent release link')
}

export function publicKeyHex(value: string): string | null {
  if (HEX64.test(value)) return value
  try {
    const decoded = nip19.decode(value)
    return decoded.type === 'npub' ? decoded.data : null
  } catch {
    return null
  }
}

export function isPackageName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\s\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(name)
  )
}

/** The event's ID and signature, checked afresh rather than from a cached verdict. */
export function isSignedEvent(event: Event, kind: number): boolean {
  if (event.kind !== kind) return false
  const { id, pubkey, created_at, tags, content, sig } = event
  try {
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  } catch {
    return false
  }
}

/** The release as this browser understands it, or the reason it will not install it. */
export function readRelease(event: Event): ExtensionRelease {
  if (!isSignedEvent(event, RELEASE_KIND)) throw new Error('The release signature is not valid')
  if (single(event, 'v') !== '1') throw new Error('This release uses an unknown protocol version')
  if (optional(event, 'kind') !== EXTENSION_ARTIFACT_KIND) {
    throw new Error('That release is not a Nostr Navigator extension')
  }
  const name = single(event, 'name')
  const version = single(event, 'version')
  const arch = single(event, 'arch')
  const sha256 = single(event, 'x')
  const artifactEventId = single(event, 'artifact')
  if (!isPackageName(name)) throw new Error('The release has an unsafe package name')
  if (!SEMVER.test(version)) throw new Error('The release version is not a semantic version')
  if (single(event, 'os') !== 'any' || arch !== 'any' || single(event, 'format') !== 'npk') {
    throw new Error('An extension release must be an npk for any system')
  }
  if (single(event, 'd') !== `${name}/${version}/${arch}`) {
    throw new Error('The release coordinate does not match its name and version')
  }
  if (!HEX64.test(sha256) || !HEX64.test(artifactEventId)) {
    throw new Error('The release has an invalid file hash or artifact reference')
  }
  // The browser cannot satisfy these, so it must not pretend the release is complete.
  if (event.tags.some((tag) => ['depends', 'requires', 'post-install'].includes(tag[0]))) {
    throw new Error('Extension releases cannot have dependencies or install actions')
  }
  return {
    id: event.id,
    publisher: event.pubkey,
    name,
    version,
    sha256,
    artifactEventId,
    createdAt: event.created_at
  }
}

/** Download candidates from the artifact event that belongs to this release. */
export function readArtifact(event: Event, release: ExtensionRelease): string[] {
  if (!isSignedEvent(event, ARTIFACT_KIND)) throw new Error('The file record signature is not valid')
  if (event.id !== release.artifactEventId) throw new Error('That is not the release’s file record')
  if (event.pubkey !== release.publisher) {
    throw new Error('The file record has a different publisher from the release')
  }
  if (single(event, 'x') !== release.sha256) {
    throw new Error('The file record and release disagree about the file hash')
  }
  if (single(event, 'm') !== 'application/zstd') {
    throw new Error('The file record is not a zstd package')
  }
  return event.tags.filter((tag) => tag[0] === 'url' && tag[1]).map((tag) => tag[1])
}

/** URLs to try, from the file record and then the publisher's Blossom server list. */
export function downloadCandidates(
  urls: string[],
  blossomLists: Event[],
  release: ExtensionRelease
): string[] {
  const list = newest(
    blossomLists.filter(
      (event) => event.pubkey === release.publisher && isSignedEvent(event, BLOSSOM_LIST_KIND)
    )
  )
  const mirrors = (list?.tags ?? [])
    .filter((tag) => tag[0] === 'server' && tag[1])
    .map((tag) => `${tag[1].replace(/\/+$/, '')}/${release.sha256}`)
  return [...new Set([...urls, ...mirrors])]
    .filter((url) => /^https:\/\//i.test(url))
    .slice(0, MAX_DOWNLOAD_URLS)
}

/**
 * The publisher's reason if this release is revoked. A revocation counts if it names
 * the release event, or the same name, version and bytes published again.
 */
export function revocationReason(release: RevocableRelease, events: Event[]): string | null {
  for (const event of events) {
    if (event.pubkey !== release.publisher || !isSignedEvent(event, REVOCATION_KIND)) continue
    try {
      if (single(event, 'v') !== '1') continue
      const target = single(event, 'e')
      const name = single(event, 'name')
      const version = single(event, 'version')
      const sha256 = single(event, 'x').toLowerCase()
      const reason = cleanText(single(event, 'reason'), 200)
      if (!reason) continue
      const sameBytes =
        name === release.name && version === release.version && sha256 === release.sha256
      if (target === release.id || sameBytes) return reason
    } catch {
      continue
    }
  }
  return null
}

/** The highest version of a package among these events that is valid and not revoked. */
export function selectRelease(
  events: Event[],
  revocations: Event[],
  publisher: string,
  name: string
): ExtensionRelease | null {
  const candidates: ExtensionRelease[] = []
  for (const event of events) {
    // Cheap checks first: a publisher may have hundreds of unrelated releases.
    if (event.pubkey !== publisher) continue
    if (!event.tags.some((tag) => tag[0] === 'name' && tag[1] === name)) continue
    try {
      const release = readRelease(event)
      if (release.name === name && !revocationReason(release, revocations)) {
        candidates.push(release)
      }
    } catch {
      continue
    }
  }
  candidates.sort(
    (a, b) =>
      compareVersions(b.version, a.version) ||
      b.createdAt - a.createdAt ||
      b.id.localeCompare(a.id)
  )
  return candidates[0] ?? null
}

/** Semantic version precedence. Build metadata is ignored. */
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left)
  const b = SEMVER.exec(right)
  if (!a || !b) throw new Error('Not a semantic version')
  for (let index = 1; index <= 3; index += 1) {
    const difference = compareNumeric(a[index], b[index])
    if (difference) return difference
  }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0
  const x = a[4].split('.')
  const y = b[4].split('.')
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    if (x[index] === undefined) return -1
    if (y[index] === undefined) return 1
    const xNumber = /^\d+$/.test(x[index])
    const yNumber = /^\d+$/.test(y[index])
    if (xNumber !== yNumber) return xNumber ? -1 : 1
    const difference = xNumber
      ? compareNumeric(x[index], y[index])
      : x[index] < y[index]
        ? -1
        : x[index] > y[index]
          ? 1
          : 0
    if (difference) return difference
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export function newest(events: Event[]): Event | null {
  return [...events].sort((a, b) => b.created_at - a.created_at)[0] ?? null
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').trim().slice(0, max)
}

function optional(event: Event, name: string): string | null {
  const found = event.tags.filter((tag) => tag[0] === name)
  if (found.length > 1) throw new Error(`The event repeats its ${name} tag`)
  return found[0]?.[1] ?? null
}

function single(event: Event, name: string): string {
  const value = optional(event, name)
  if (value === null) throw new Error(`The event has no ${name} tag`)
  return value
}
