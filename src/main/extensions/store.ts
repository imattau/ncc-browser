/**
 * Fetches an extension release from relays and verifies it down to the files, ready
 * for the install review. Installs nothing.
 */

import { createHash } from 'node:crypto'
import { nip19, type Event, type Filter } from 'nostr-tools'
import {
  ARTIFACT_KIND,
  BLOSSOM_LIST_KIND,
  RELEASE_KIND,
  REVOCATION_KIND,
  downloadCandidates,
  isPackageName,
  isSignedEvent,
  newest,
  publicKeyHex,
  readArtifact,
  readRelease,
  revocationReason,
  selectRelease,
  type ExtensionRelease,
  type ReleaseReference,
  type RevocableRelease
} from '@shared/extension-release'
import { MAX_EXTENSION_BYTES } from '@shared/extensions'
import { readNpk } from './tar'
import type { ZipEntry } from './zip'

/** npack's own defaults, so a release published with them can be found. */
const NPACK_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
const RELAY_LIST_KIND = 10002
const PAGE_SIZE = 500
const MAX_PAGES = 6
const MAX_FOREIGN_RELAYS = 6

export interface StoreRelays {
  queryAuthReport(relays: string[], filter: Filter): Promise<{ events: Event[]; answered: number }>
}

export interface ExtensionStoreDeps {
  relays: StoreRelays
  /** The user's own relays. */
  userRelays: () => string[]
  download: (url: string, maxBytes: number) => Promise<Buffer>
}

export interface Lookup {
  release: ExtensionRelease
  relays: string[]
  /** `unknown` means no relay answered the question, not that the release is safe. */
  revocation: 'checked' | 'unknown'
  revoked: string | null
}

interface Answer {
  events: Event[]
  answered: boolean
}

export class ExtensionStore {
  constructor(private readonly deps: ExtensionStoreDeps) {}

  /** The release a reference points at. A revoked one is only returned if named exactly. */
  async find(reference: ReleaseReference): Promise<Lookup> {
    if (reference.type === 'package') {
      const relays = await this.relaysFor(reference.publisher)
      const [releases, revocations] = await Promise.all([
        this.releases(relays, reference.publisher),
        this.revocations(relays, reference.publisher)
      ])
      if (!releases.answered) throw new Error('No relay answered. Check your connection and try again.')
      const release = selectRelease(
        releases.events,
        revocations.events,
        reference.publisher,
        reference.name
      )
      if (!release) throw new Error('No installable release of that extension was found')
      return lookupResult(release, relays, revocations)
    }

    const first = this.relaySet(reference.relays)
    const found = await this.query(first, { kinds: [RELEASE_KIND], ids: [reference.id] })
    const event = found.events.find((candidate) => candidate.id === reference.id)
    if (!event) throw new Error('That release was not found on the relays')
    const release = readRelease(event)
    const relays = await this.relaysFor(release.publisher, reference.relays)
    return lookupResult(release, relays, await this.revocations(relays, release.publisher))
  }

  /**
   * Whether an installed release is revoked. Needs only what was saved at install, so
   * it works even if the release event itself can no longer be found.
   */
  async checkRevocation(
    release: RevocableRelease
  ): Promise<{ revoked: string | null; checked: boolean }> {
    const relays = await this.relaysFor(release.publisher)
    const answer = await this.revocations(relays, release.publisher)
    return { revoked: revocationReason(release, answer.events), checked: answer.answered }
  }

  /** Download a release and check it. Returns only the extension's own files. */
  async fetchFiles({ release, relays }: Lookup): Promise<ZipEntry[]> {
    const [records, lists] = await Promise.all([
      this.query(relays, { kinds: [ARTIFACT_KIND], ids: [release.artifactEventId] }),
      this.query(relays, { kinds: [BLOSSOM_LIST_KIND], authors: [release.publisher] })
    ])
    const record = records.events.find(
      (event) => event.id === release.artifactEventId && isSignedEvent(event, ARTIFACT_KIND)
    )
    if (!record) throw new Error('The release’s file record was not found on the relays')
    const urls = downloadCandidates(readArtifact(record, release), lists.events, release)
    if (urls.length === 0) throw new Error('The release has no HTTPS download address')
    return unpackExtension(await this.download(urls, release.sha256), release)
  }

  private async download(urls: string[], sha256: string): Promise<Buffer> {
    let failure = 'no address worked'
    for (const url of urls) {
      try {
        const bytes = await this.deps.download(url, MAX_EXTENSION_BYTES)
        if (createHash('sha256').update(bytes).digest('hex') === sha256) return bytes
        failure = 'the file did not match the signed hash'
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`Could not download the package: ${failure}`)
  }

  private releases(relays: string[], publisher: string): Promise<Answer> {
    return this.queryAll(relays, { kinds: [RELEASE_KIND], authors: [publisher] })
  }

  private revocations(relays: string[], publisher: string): Promise<Answer> {
    return this.queryAll(relays, { kinds: [REVOCATION_KIND], authors: [publisher] })
  }

  /**
   * Every matching event, paged one relay at a time. A publisher with many releases
   * would otherwise hide older packages, or revocations, behind a relay's limit.
   */
  private async queryAll(relays: string[], filter: Filter): Promise<Answer> {
    const events = new Map<string, Event>()
    let answered = false
    await Promise.all(
      relays.map(async (relay) => {
        const seen = new Set<string>()
        let until: number | undefined
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await this.query([relay], {
            ...filter,
            limit: PAGE_SIZE,
            ...(until === undefined ? {} : { until })
          })
          answered ||= result.answered
          const fresh = result.events.filter((event) => !seen.has(event.id))
          if (fresh.length === 0) return
          for (const event of fresh) {
            seen.add(event.id)
            events.set(event.id, event)
          }
          until = Math.min(...fresh.map((event) => event.created_at))
        }
      })
    )
    return { events: [...events.values()], answered }
  }

  private async query(relays: string[], filter: Filter): Promise<Answer> {
    try {
      const report = await this.deps.relays.queryAuthReport(relays, filter)
      return { events: report.events, answered: report.answered > 0 }
    } catch {
      return { events: [], answered: false }
    }
  }

  private relaySet(hints: string[]): string[] {
    return [...new Set([...this.deps.userRelays(), ...NPACK_RELAYS, ...publicRelays(hints)])]
  }

  /** The base relays plus the publisher's NIP-65 write relays. */
  private async relaysFor(publisher: string, hints: string[] = []): Promise<string[]> {
    const base = this.relaySet(hints)
    const lists = await this.query(base, { kinds: [RELAY_LIST_KIND], authors: [publisher] })
    const list = newest(
      lists.events.filter(
        (event) => event.pubkey === publisher && isSignedEvent(event, RELAY_LIST_KIND)
      )
    )
    const write = (list?.tags ?? [])
      .filter((tag) => tag[0] === 'r' && tag[1] && tag[2] !== 'read')
      .map((tag) => tag[1])
    return [...new Set([...base, ...publicRelays(write)])]
  }
}

function lookupResult(release: ExtensionRelease, relays: string[], revocations: Answer): Lookup {
  const revoked = revocationReason(release, revocations.events)
  return {
    release,
    relays,
    revocation: revoked || revocations.answered ? 'checked' : 'unknown',
    revoked
  }
}

/** Relays named by strangers must be TLS and must not point into the local network. */
function publicRelays(urls: string[]): string[] {
  return urls
    .filter((value) => {
      try {
        const url = new URL(value)
        const host = url.hostname.replace(/^\[|\]$/g, '')
        return (
          url.protocol === 'wss:' &&
          !url.username &&
          host.includes('.') &&
          !/^[0-9.]+$/.test(host) &&
          !host.includes(':') &&
          !/\.(local|localhost|internal|lan|home\.arpa)$/i.test(host)
        )
      } catch {
        return false
      }
    })
    .slice(0, MAX_FOREIGN_RELAYS)
}

/** Check the package against its release and return the files under `extension/`. */
export function unpackExtension(bytes: Buffer, release: ExtensionRelease): ZipEntry[] {
  const entries = readNpk(bytes)
  const embedded = parseJson(entries, '.npack/manifest.json')
  if (
    typeof embedded.publisher !== 'string' ||
    publisherOf(embedded.publisher) !== release.publisher ||
    embedded.name !== release.name ||
    !isPackageName(release.name) ||
    embedded.version !== release.version ||
    embedded.kind !== 'navigator-extension'
  ) {
    throw new Error('The package contents do not match the signed release')
  }
  const files = entries
    .filter((entry) => entry.name.startsWith('extension/'))
    .map((entry) => ({ name: entry.name.slice('extension/'.length), data: entry.data }))
  if (parseJson(files, 'manifest.json').version !== release.version) {
    throw new Error('The extension version does not match the signed release')
  }
  return files
}

function publisherOf(value: string): string | null {
  return publicKeyHex(value.toLowerCase())
}

export function publisherLabel(publisher: string): string {
  return nip19.npubEncode(publisher)
}

function parseJson(entries: ZipEntry[], name: string): Record<string, unknown> {
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`The package has no ${name}`)
  try {
    const value: unknown = JSON.parse(entry.data.toString('utf8'))
    if (value && typeof value === 'object') return value as Record<string, unknown>
  } catch {
    // Falls through to the message below.
  }
  throw new Error(`The package has an invalid ${name}`)
}
