import { randomBytes } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Event, EventTemplate } from 'nostr-tools'
import {
  MAX_NSITE_FILE_BYTES,
  MAX_NSITE_TOTAL_BYTES,
  normalizeNsiteServers,
  nsiteSiteAddress,
  signNsiteManifest,
  validateNsiteFiles,
  validateNsiteSiteId,
  type NsiteProgress,
  type NsitePublishInput,
  type NsitePublishResult,
  type NsitePublishState,
  type NsiteRelayReport,
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
  }): Promise<ServerOutcome>
  verify(server: string, hash: string): Promise<boolean>
  publish(event: Event, relays: string[], signer: NsiteSigner): Promise<NsiteRelayReport[]>
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
    onProgress?: (progress: NsiteProgress) => void
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
        const bytes = await readFile(join(input.folder, file.path.replace(/^\/+/, '')))
        if (sha256Hex(bytes) !== file.hash) {
          throw new Error(`${file.path} changed on disk after it was scanned. Choose the folder again.`)
        }
        let stored = false
        for (const server of servers) {
          const outcome = await this.deps.network.upload({
            server,
            hash: file.hash,
            bytes,
            path: file.path,
            signer: provider
          })
          onProgress?.({
            phase: 'uploading',
            done,
            total: input.files.length,
            label: 'Uploading files',
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

      onProgress?.({
        phase: 'publishing',
        done: 0,
        total: relays.length,
        label: 'Signing the manifest'
      })
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
      const reports = await this.deps.network.publish(manifest, relays, provider)
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
      if (existing) this.deps.store.markError(existing.id, messageOf(error))
      this.changed()
      throw error
    }
  }

  async verify(id: string, onProgress?: (progress: NsiteProgress) => void): Promise<NsiteVerifyResult> {
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
      let found = false
      for (const server of site.servers) {
        if (await this.deps.network.verify(server, file.hash)) {
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

  remove(id: string): void {
    this.deps.store.remove(id)
    this.changed()
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

  verify(server: string, hash: string): Promise<boolean> {
    return verifyBlob(server, hash)
  }

  async publish(event: Event, relays: string[], signer: NsiteSigner): Promise<NsiteRelayReport[]> {
    return Promise.all(
      [...new Set(relays)].slice(0, MAX_RELAYS).map(async (relay) => {
        try {
          const message = await withTimeout(
            this.pool.publishWithAuth(relay, event, (template: EventTemplate) =>
              signer.signEvent(template)
            ),
            PUBLISH_TIMEOUT_MS
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
