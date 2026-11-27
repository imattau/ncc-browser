import { randomBytes } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Event, EventTemplate } from 'nostr-tools'
import {
  MAX_NSITE_FILE_BYTES,
  MAX_NSITE_TOTAL_BYTES,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  normalizeNsiteServers,
  nsiteSiteAddress,
  nsiteSiteKey,
  signNsiteManifest,
  validateNsiteFiles,
  validateNsiteSiteId,
  type NsiteDiscoverResult,
  type NsiteProgress,
  type NsitePublishInput,
  type NsitePublishResult,
  type NsitePublishState,
  type NsiteRelayReport,
  type NsiteRemoveResult,
  type NsiteSiteFile,
  type NsiteVerifyResult,
  type PublishedNsite
} from '@shared/nsite-publish'
import type { IdentityStatus } from '@shared/types'
import type { RelayPool } from '../relay/pool'
import type { ConfigStore } from '../config'
import { discoverWriteRelays } from '../relay/nip65'
import { sha256Hex, uploadBlob, verifyBlob, type NsiteSigner, type ServerOutcome } from './blossom'
import type { NsiteStore } from './store'

export interface NsiteScan {
  folder: string
  files: NsiteSiteFile[]
  totalBytes: number
  problems: string[]
}

export interface NsiteNetwork {
  relaysFor(ownerHex: string): Promise<string[]>
  upload(options: {
    server: string
    hash: string
    bytes: Uint8Array
    path: string
    signer: NsiteSigner
    signal?: AbortSignal
  }): Promise<ServerOutcome>
  verify(server: string, hash: string, signal?: AbortSignal): Promise<boolean>
  publish(
    event: Event,
    relays: string[],
    signer: NsiteSigner,
    signal?: AbortSignal
  ): Promise<NsiteRelayReport[]>
  query?(
    relays: string[],
    filter: { kinds: number[]; authors: string[]; limit?: number },
    signal?: AbortSignal
  ): Promise<Event[]>
}

export class NsitePublishCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'NsitePublishCancelled'
  }
}

export interface NsiteProvider extends NsiteSigner {
  getPublicKey(): Promise<string>
}

export interface NsitePublishDeps {
  store: NsiteStore
  identity: {
    provider(): NsiteProvider | null
    status(): IdentityStatus
  }
  network: NsiteNetwork
  now?: () => number
  onChange?: (state: NsitePublishState) => void
}

const MAX_RELAYS = 12
const PUBLISH_TIMEOUT_MS = 15_000

/**
 * Native NIP-5A publishing: scan a folder, upload blobs, sign the manifest with the
 * active identity and publish it through the relay pool. The standalone page uses the
 * same protocol; this path avoids browser CORS and per-file NIP-07 prompts.
 */
export class NsitePublishService {
  private readonly now: () => number

  constructor(private readonly deps: NsitePublishDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  state(): NsitePublishState {
    return this.deps.store.state()
  }

  /**
   * Rebuild the local index from the active identity's latest NIP-5A manifests.
   * Removed sites are left hidden; republishing the same address unhides them.
   */
  async discover(signal?: AbortSignal): Promise<NsiteDiscoverResult> {
    const provider = this.deps.identity.provider()
    if (!provider) {
      return {
        state: this.state(),
        found: 0,
        relays: 0,
        error: 'Connect a Nostr identity to find published sites.'
      }
    }
    const owner = (await provider.getPublicKey()).toLowerCase()
    let relays: string[] = []
    try {
      relays = await this.resolveRelays(owner, [])
    } catch {
      relays = []
    }
    if (relays.length === 0) {
      return {
        state: this.state(),
        found: 0,
        relays: 0,
        error: 'No relays available to look for published sites.'
      }
    }

    if (!this.deps.network.query) {
      return {
        state: this.state(),
        found: 0,
        relays: relays.length,
        error: 'Relay discovery is not available in this build.'
      }
    }
    let events: Event[] = []
    try {
      events = await this.deps.network.query(
        relays,
        { kinds: [NSITE_NAMED_KIND, NSITE_ROOT_KIND], authors: [owner], limit: 500 },
        signal
      )
    } catch (error) {
      return { state: this.state(), found: 0, relays: relays.length, error: messageOf(error) }
    }

    // NIP-09 deletions are advisory but a relay that retains a deleted manifest must
    // not make it reappear. A newer manifest for the same address wins over a deletion.
    const deletedIds = new Set<string>()
    const deletedAddresses = new Map<string, number>()
    try {
      const deletions = await this.deps.network.query(
        relays,
        { kinds: [5], authors: [owner], limit: 500 },
        signal
      )
      for (const deletion of deletions) {
        for (const [name, value] of deletion.tags) {
          if (name === 'e' && value) deletedIds.add(value)
          if (name !== 'a' || !value) continue
          const [kindText, pubkey, siteId] = value.split(':')
          if (pubkey?.toLowerCase() !== owner) continue
          const kind = Number(kindText)
          if (kind !== NSITE_NAMED_KIND && kind !== NSITE_ROOT_KIND) continue
          const key = nsiteSiteKey(owner, siteId || null)
          deletedAddresses.set(key, Math.max(deletedAddresses.get(key) ?? 0, deletion.created_at))
        }
      }
    } catch {
      // A deletion query failure should not hide otherwise valid manifests.
    }

    const latest = new Map<string, Event>()
    for (const event of events) {
      if (event.pubkey.toLowerCase() !== owner) continue
      const siteId =
        event.kind === NSITE_ROOT_KIND
          ? null
          : event.tags.find((tag) => tag[0] === 'd')?.[1] ?? null
      if (siteId && validateNsiteSiteId(siteId)) continue
      const key = nsiteSiteKey(owner, siteId)
      const previous = latest.get(key)
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id > previous.id)
      ) {
        latest.set(key, event)
      }
    }

    let found = 0
    const hidden = new Set(this.deps.store.hidden())
    for (const [key, event] of latest) {
      if (hidden.has(key)) continue
      if (deletedIds.has(event.id)) continue
      if (event.created_at <= (deletedAddresses.get(key) ?? 0)) continue
      const siteId =
        event.kind === NSITE_ROOT_KIND
          ? null
          : event.tags.find((tag) => tag[0] === 'd')?.[1] ?? null
      const files: NsiteSiteFile[] = event.tags
        .filter((tag) => tag[0] === 'path' && typeof tag[1] === 'string' && typeof tag[2] === 'string')
        .map((tag) => ({ path: tag[1], hash: tag[2].toLowerCase(), size: 0 }))
      if (files.length === 0 || validateNsiteFiles(files).length > 0) continue
      const servers = normalizeNsiteServers(
        event.tags.filter((tag) => tag[0] === 'server' && typeof tag[1] === 'string').map((tag) => tag[1])
      )
      if (servers.length === 0) continue
      const existing = this.deps.store.findByAddress(owner, siteId)
      const title = event.tags.find((tag) => tag[0] === 'title')?.[1]
      const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
      const source = event.tags.find((tag) => tag[0] === 'source')?.[1]
      this.deps.store.upsert({
        id: existing?.id ?? randomBytes(8).toString('hex'),
        owner,
        siteId,
        ...(title ? { title: title.slice(0, 120) } : {}),
        ...(description ? { description: description.slice(0, 400) } : {}),
        ...(source ? { source: source.slice(0, 500) } : {}),
        servers,
        files,
        manifestEventId: event.id,
        createdAt: existing?.createdAt ?? event.created_at,
        updatedAt: event.created_at,
        lastPublishedAt: event.created_at
      })
      found += 1
    }
    this.changed()
    return { state: this.state(), found, relays: relays.length }
  }

  async scanFolder(folder: string): Promise<NsiteScan> {
    const files = await collectFiles(folder)
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    return {
      folder,
      files,
      totalBytes,
      problems: validateNsiteFiles(files)
    }
  }

  async publish(
    input: NsitePublishInput & { folder: string; files: NsiteSiteFile[] },
    onProgress?: (progress: NsiteProgress) => void,
    signal?: AbortSignal
  ): Promise<NsitePublishResult> {
    const siteId = input.siteId === '' ? null : input.siteId
    const siteIdError = validateNsiteSiteId(siteId)
    if (siteIdError) throw new Error(siteIdError)
    const fileProblems = validateNsiteFiles(input.files)
    if (fileProblems.length > 0) throw new Error(fileProblems.join(' '))
    const servers = normalizeNsiteServers(input.servers)
    if (servers.length === 0) throw new Error('Add at least one Blossom server.')

    const provider = this.deps.identity.provider()
    if (!provider) throw new Error('Connect a Nostr identity to publish a site.')
    const owner = (await provider.getPublicKey()).toLowerCase()
    const existing = this.deps.store.findByAddress(owner, siteId)
    const now = this.now()
    const createdAt = Math.max(now, (existing?.lastPublishedAt ?? 0) + 1)

    const relays = await this.resolveRelays(owner, input.relays)
    if (relays.length === 0) throw new Error('Add at least one relay.')

    try {
      const served = new Set<string>()
      let done = 0
      onProgress?.({
        phase: 'uploading',
        done: 0,
        total: input.files.length,
        label: 'Uploading files'
      })
      for (const file of input.files) {
        throwIfCancelled(signal)
        onProgress?.({
          phase: 'uploading',
          done,
          total: input.files.length,
          label: 'Uploading files',
          current: file.path
        })
        const bytes = await readFile(join(input.folder, file.path.replace(/^\/+/, '')))
        if (sha256Hex(bytes) !== file.hash) {
          throw new Error(`${file.path} changed on disk after it was scanned. Choose the folder again.`)
        }
        let stored = false
        for (const server of servers) {
          throwIfCancelled(signal)
          const outcome = await this.deps.network.upload({
            server,
            hash: file.hash,
            bytes,
            path: file.path,
            signer: provider,
            ...(signal ? { signal } : {})
          })
          onProgress?.({
            phase: 'uploading',
            done,
            total: input.files.length,
            label: 'Uploading files',
            current: file.path,
            log: `${file.path} → ${outcome.server}: ${outcome.message}`
          })
          if (outcome.ok) {
            stored = true
            served.add(outcome.server)
          }
        }
        if (!stored) {
          throw new Error(`No Blossom server accepted ${file.path}. Nothing was published.`)
        }
        done += 1
        onProgress?.({
          phase: 'uploading',
          done,
          total: input.files.length,
          label: 'Uploading files'
        })
      }

      throwIfCancelled(signal)
      onProgress?.({ phase: 'signing', done: 0, total: 1, label: 'Signing the manifest' })
      const manifest = await signNsiteManifest(
        {
          siteId,
          title: input.title,
          description: input.description,
          source: input.source,
          files: input.files,
          servers: [...served]
        },
        provider,
        createdAt
      )
      throwIfCancelled(signal)
      onProgress?.({
        phase: 'publishing',
        done: 0,
        total: relays.length,
        label: 'Publishing the manifest'
      })
      const reports = await this.deps.network.publish(manifest, relays, provider, signal)
      onProgress?.({
        phase: 'publishing',
        done: reports.filter((report) => report.ok).length,
        total: reports.length,
        label: 'Publishing the manifest'
      })
      if (!reports.some((report) => report.ok)) {
        throw new Error('No relay accepted the manifest. The files are uploaded, so you can retry.')
      }

      const site: PublishedNsite = {
        id: existing?.id ?? randomBytes(8).toString('hex'),
        owner,
        siteId,
        title: input.title.trim().slice(0, 120),
        description: input.description.trim().slice(0, 400),
        source: input.source.trim().slice(0, 500),
        servers: [...served],
        files: input.files,
        manifestEventId: manifest.id,
        createdAt: existing?.createdAt ?? createdAt,
        updatedAt: now,
        lastPublishedAt: createdAt
      }
      this.deps.store.upsert(site)
      this.changed()
      return {
        site,
        address: nsiteSiteAddress(owner, siteId),
        reports
      }
    } catch (error) {
      if (!(error instanceof NsitePublishCancelled) && existing) {
        this.deps.store.markError(existing.id, messageOf(error))
      }
      this.changed()
      throw error
    }
  }

  async verify(
    id: string,
    onProgress?: (progress: NsiteProgress) => void,
    signal?: AbortSignal
  ): Promise<NsiteVerifyResult> {
    const site = this.deps.store.find(id)
    if (!site) throw new Error('That site is not in this browser.')
    const missing: string[] = []
    let checked = 0
    onProgress?.({
      phase: 'verifying',
      done: 0,
      total: site.files.length,
      label: 'Verifying uploaded files'
    })
    for (const file of site.files) {
      throwIfCancelled(signal)
      let found = false
      for (const server of site.servers) {
        throwIfCancelled(signal)
        if (await this.deps.network.verify(server, file.hash, signal)) {
          found = true
          break
        }
      }
      if (!found) missing.push(file.path)
      checked += 1
      onProgress?.({
        phase: 'verifying',
        done: checked,
        total: site.files.length,
        label: 'Verifying uploaded files'
      })
    }
    return { id, checked, missing }
  }

  async remove(id: string): Promise<NsiteRemoveResult> {
    const site = this.deps.store.find(id)
    if (!site) return { state: this.state(), reports: [] }

    let reports: NsiteRelayReport[] = []
    let error: string | undefined
    const provider = this.deps.identity.provider()
    if (!provider) {
      error = 'No identity is available to sign the deletion request; removed locally only.'
    } else {
      const owner = (await provider.getPublicKey()).toLowerCase()
      if (owner !== site.owner) {
        error = 'The active identity does not own this site; removed locally only.'
      } else {
        try {
          const kind = site.siteId ? NSITE_NAMED_KIND : NSITE_ROOT_KIND
          const address = `${kind}:${owner}:${site.siteId ?? ''}`
          const event = await provider.signEvent({
            kind: 5,
            created_at: Math.max(this.now(), site.lastPublishedAt ?? 0) + 1,
            tags: [
              ['a', address],
              ['e', site.manifestEventId],
              ['k', String(kind)]
            ],
            content: 'Delete nsite manifest'
          })
          const relays = await this.resolveRelays(owner, [])
          if (relays.length === 0) {
            error = 'No relays are available; removed locally only.'
          } else {
            reports = await this.deps.network.publish(event, relays, provider)
            if (!reports.some((report) => report.ok)) {
              error = 'No relay accepted the deletion request; removed locally only.'
            }
          }
        } catch (publishError) {
          error = `Could not publish the deletion request: ${messageOf(publishError)}`
        }
      }
    }

    this.deps.store.remove(id)
    this.changed()
    return { state: this.state(), reports, ...(error ? { error } : {}) }
  }

  private async resolveRelays(owner: string, requested: string[]): Promise<string[]> {
    const valid = requested
      .map((relay) => relay.trim())
      .filter((relay) => /^wss?:\/\//i.test(relay))
    if (valid.length > 0) return [...new Set(valid)].slice(0, MAX_RELAYS)
    return this.deps.network.relaysFor(owner)
  }

  private changed(): void {
    this.deps.onChange?.(this.deps.store.state())
  }
}

export class RelayNsiteNetwork implements NsiteNetwork {
  constructor(
    private readonly pool: RelayPool,
    private readonly config: ConfigStore
  ) {}

  async relaysFor(ownerHex: string): Promise<string[]> {
    const configured = this.config.getRelays()
    try {
      const extra = await discoverWriteRelays(this.pool.query, ownerHex, configured)
      return [...new Set([...configured, ...extra])].slice(0, MAX_RELAYS)
    } catch {
      return configured.slice(0, MAX_RELAYS)
    }
  }

  upload(options: Parameters<typeof uploadBlob>[0]): Promise<ServerOutcome> {
    return uploadBlob(options)
  }

  verify(server: string, hash: string, signal?: AbortSignal): Promise<boolean> {
    return verifyBlob(server, hash, signal)
  }

  query(
    relays: string[],
    filter: { kinds: number[]; authors: string[]; limit?: number },
    signal?: AbortSignal
  ): Promise<Event[]> {
    throwIfCancelled(signal)
    return withAbort(
      this.pool.query([...new Set(relays)].slice(0, MAX_RELAYS), filter),
      signal
    )
  }

  async publish(
    event: Event,
    relays: string[],
    signer: NsiteSigner,
    signal?: AbortSignal
  ): Promise<NsiteRelayReport[]> {
    throwIfCancelled(signal)
    return Promise.all(
      [...new Set(relays)].slice(0, MAX_RELAYS).map(async (relay) => {
        try {
          const message = await withAbort(
            withTimeout(
              this.pool.publishWithAuth(relay, event, (template: EventTemplate) =>
                signer.signEvent(template)
              ),
              PUBLISH_TIMEOUT_MS
            ),
            signal
          )
          return { relay, ok: true, message }
        } catch (error) {
          return { relay, ok: false, message: messageOf(error) }
        }
      })
    )
  }
}

async function collectFiles(root: string): Promise<NsiteSiteFile[]> {
  const files: NsiteSiteFile[] = []
  let total = 0
  await visit(root, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue
      if (entry.isSymbolicLink()) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full)
      if (info.size > MAX_NSITE_FILE_BYTES) {
        files.push({ path: `/${relative}`, hash: '0'.repeat(64), size: info.size })
        total += info.size
        continue
      }
      const bytes = await readFile(full)
      files.push({ path: `/${relative}`, hash: sha256Hex(bytes), size: bytes.length })
      total += bytes.length
      if (total > MAX_NSITE_TOTAL_BYTES) return
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay timed out')), timeoutMs)
    timer.unref?.()
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NsitePublishCancelled()
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new NsitePublishCancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new NsitePublishCancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
