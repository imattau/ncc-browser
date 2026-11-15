/**
 * Hash-verified Blossom blobs for NIP-5A sites.
 *
 * A blob is only handed to the protocol handler after its sha256 matches the manifest.
 * That makes the disk cache permanently safe: a hash never changes meaning, so a cache
 * hit needs no revalidation and no trust in the server that first supplied it.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mimeForPath } from './mime'

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MEMORY_BYTES = 32 * 1024 * 1024
const MAX_SERVERS = 8
const MAX_PARALLEL = 6

export type BlobFailure = 'blob-unavailable' | 'hash-mismatch' | 'too-large'

export type BlobResult =
  | { ok: true; bytes: Buffer; type: string; cached: boolean }
  | { ok: false; code: BlobFailure; message: string }

export interface BlobStoreOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** Null keeps everything in memory: private and Tor tabs must not leave files behind. */
  directory: string | null
  maxFileBytes?: number
  maxTotalBytes?: number
}

interface Entry {
  size: number
  type: string
  at: number
}

export class NsiteBlobs {
  private readonly memory = new Map<string, Buffer>()
  private readonly types = new Map<string, string>()
  private memoryBytes = 0
  private readonly index = new Map<string, Entry>()
  private totalBytes = 0
  private loaded = false
  private readonly slots = new Semaphore(MAX_PARALLEL)
  private readonly failures = new Map<string, number>()

  constructor(private readonly options: BlobStoreOptions) {}

  async get(hash: string, servers: string[], hintPath = ''): Promise<BlobResult> {
    const cached = this.fromMemory(hash)
    if (cached) return { ok: true, bytes: cached.bytes, type: cached.type, cached: true }

    const disk = this.fromDisk(hash)
    if (disk) {
      this.toMemory(hash, disk.bytes, disk.type)
      return { ok: true, bytes: disk.bytes, type: disk.type, cached: true }
    }

    const ordered = [...new Set(servers.map((server) => server.replace(/\/+$/, '')))]
      .filter(Boolean)
      .sort((a, b) => (this.failures.get(b) ?? 0) - (this.failures.get(a) ?? 0))
      .slice(0, MAX_SERVERS)

    let sawMismatch = false
    let sawTooLarge = false

    for (const server of ordered) {
      let response: Response
      try {
        response = await this.slots.run(() =>
          this.options.fetch(`${server}/${hash}`, { redirect: 'follow' })
        )
      } catch {
        this.fail(server)
        continue
      }
      if (response.status !== 200) {
        this.fail(server)
        continue
      }

      const type = response.headers.get('content-type') || mimeForPath(hintPath)
      let bytes: Buffer
      try {
        bytes = await readCapped(response, this.maxFileBytes())
      } catch (error) {
        if (error instanceof Error && error.message === 'too-large') sawTooLarge = true
        this.fail(server)
        continue
      }

      if (sha256(bytes) !== hash.toLowerCase()) {
        sawMismatch = true
        this.fail(server)
        continue
      }

      this.failures.delete(server)
      this.toMemory(hash, bytes, type)
      this.toDisk(hash, bytes, type)
      return { ok: true, bytes, type, cached: false }
    }

    if (sawMismatch) {
      return {
        ok: false,
        code: 'hash-mismatch',
        message: 'A Blossom server returned bytes that do not match the manifest hash'
      }
    }
    if (sawTooLarge) {
      return {
        ok: false,
        code: 'too-large',
        message: `The file is larger than ${Math.round(this.maxFileBytes() / (1024 * 1024))} MB`
      }
    }
    return {
      ok: false,
      code: 'blob-unavailable',
      message: ordered.length
        ? 'No Blossom server returned this file'
        : 'The manifest lists no Blossom servers'
    }
  }

  /** Drop every cached blob for a site, used by "clear site data". */
  clear(): void {
    this.memory.clear()
    this.types.clear()
    this.memoryBytes = 0
    this.index.clear()
    this.totalBytes = 0
    if (this.options.directory) {
      try {
        this.persistIndex()
      } catch {
        // Nothing to do: an unreadable cache is rebuilt on demand.
      }
    }
  }

  cachedBytes(): number {
    return this.totalBytes
  }

  private fromMemory(hash: string): { bytes: Buffer; type: string } | null {
    const bytes = this.memory.get(hash)
    if (!bytes) return null
    return { bytes, type: this.types.get(hash) ?? 'application/octet-stream' }
  }

  private fromDisk(hash: string): { bytes: Buffer; type: string } | null {
    const directory = this.options.directory
    if (!directory) return null
    this.load()
    const entry = this.index.get(hash)
    if (!entry) return null
    try {
      const bytes = readFileSync(join(directory, hash))
      entry.at = Date.now()
      return { bytes, type: entry.type }
    } catch {
      this.index.delete(hash)
      this.totalBytes -= entry.size
      return null
    }
  }

  private toMemory(hash: string, bytes: Buffer, type: string): void {
    if (bytes.length > MEMORY_BYTES) return
    const existing = this.memory.get(hash)
    if (existing) this.memoryBytes -= existing.length
    this.memory.set(hash, bytes)
    this.types.set(hash, type)
    this.memoryBytes += bytes.length
    while (this.memoryBytes > MEMORY_BYTES && this.memory.size > 1) {
      const oldest = this.memory.keys().next().value as string
      this.memoryBytes -= this.memory.get(oldest)?.length ?? 0
      this.memory.delete(oldest)
      this.types.delete(oldest)
    }
  }

  private toDisk(hash: string, bytes: Buffer, type: string): void {
    const directory = this.options.directory
    if (!directory) return
    try {
      mkdirSync(directory, { recursive: true })
      this.load()
      const target = join(directory, hash)
      const tmp = `${target}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, target)
      const previous = this.index.get(hash)
      if (previous) this.totalBytes -= previous.size
      this.index.set(hash, { size: bytes.length, type, at: Date.now() })
      this.totalBytes += bytes.length
      this.evict()
      this.persistIndex()
    } catch {
      // A read-only profile must not break page loads.
    }
  }

  private evict(): void {
    const max = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    if (this.totalBytes <= max) return
    const oldest = [...this.index.entries()].sort((a, b) => a[1].at - b[1].at)
    const directory = this.options.directory
    for (const [hash, entry] of oldest) {
      if (this.totalBytes <= max) break
      try {
        if (directory) unlinkSync(join(directory, hash))
      } catch {
        // Missing files are fine; the index entry is what matters.
      }
      this.index.delete(hash)
      this.totalBytes -= entry.size
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const directory = this.options.directory
    if (!directory) return
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')) as {
        entries?: Record<string, Entry>
      }
      for (const [hash, entry] of Object.entries(parsed.entries ?? {})) {
        if (!entry || typeof entry.size !== 'number' || typeof entry.type !== 'string') continue
        try {
          statSync(join(directory, hash))
        } catch {
          continue
        }
        this.index.set(hash, entry)
        this.totalBytes += entry.size
      }
    } catch {
      // First run, or a corrupt index: start empty.
    }
  }

  private persistIndex(): void {
    const directory = this.options.directory
    if (!directory) return
    mkdirSync(directory, { recursive: true })
    const target = join(directory, 'index.json')
    const tmp = `${target}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ entries: Object.fromEntries(this.index) })}\n`)
    renameSync(tmp, target)
  }

  private fail(server: string): void {
    this.failures.set(server, (this.failures.get(server) ?? 0) + 1)
  }

  private maxFileBytes(): number {
    return this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }
}

async function readCapped(response: Response, max: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('too-large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}
