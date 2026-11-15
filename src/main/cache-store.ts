/**
 * Optional on-disk cache for resolved locators.
 *
 * Records are public by construction: plaintext NCC-05 payloads. Encrypted records are
 * deliberately never persisted, so a decrypted private locator cannot be left behind
 * on disk.
 *
 * Entries also carry a `validatedAt` timestamp. A record's own `expiresAt` says how long
 * the publisher vouches for it; `validatedAt` says when this browser last confirmed it
 * against relays. The resolver uses the latter to re-check rotations instead of pinning
 * an endpoint for the record's whole TTL.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ResolvedService } from '@shared/types'

export interface LocatorCacheEntry {
  record: ResolvedService
  /** Unix seconds when a relay query last produced this record. */
  validatedAt: number
}

export interface LocatorStore {
  get(hexPubkey: string, service: string): LocatorCacheEntry | null
  /** Store a record; `validatedAt` defaults to now. */
  set(record: ResolvedService, validatedAt?: number): void
  delete(hexPubkey: string, service: string): void
}

interface CacheFile {
  version: 2
  entries: Record<string, LocatorCacheEntry>
}

/**
 * v1 stored bare records, with no way to tell a fresh confirmation from one written
 * days ago. Those entries are dropped on upgrade so a stale endpoint cannot survive.
 */
const CACHE_VERSION = 2

function keyOf(hexPubkey: string, service: string): string {
  return `${hexPubkey}:${service}`
}

function isResolvedService(value: unknown): value is ResolvedService {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ResolvedService>
  return (
    typeof record.hexPubkey === 'string' &&
    typeof record.service === 'string' &&
    typeof record.expiresAt === 'number' &&
    Array.isArray(record.endpoints)
  )
}

function isEntry(value: unknown): value is LocatorCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<LocatorCacheEntry>
  return isResolvedService(entry.record) && typeof entry.validatedAt === 'number'
}

export class LocatorCacheStore implements LocatorStore {
  private entries = new Map<string, LocatorCacheEntry>()
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly maxEntries = 500
  ) {}

  get(hexPubkey: string, service: string): LocatorCacheEntry | null {
    this.load()
    const key = keyOf(hexPubkey, service)
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.record.expiresAt <= this.now()) {
      this.entries.delete(key)
      this.flush()
      return null
    }
    return entry
  }

  set(record: ResolvedService, validatedAt = this.now()): void {
    if (record.encrypted) return
    this.load()
    // A revalidation must never look older than the record it confirmed.
    const stamp = Math.min(
      Number.isFinite(validatedAt) && validatedAt > 0 ? validatedAt : this.now(),
      this.now()
    )
    this.entries.set(keyOf(record.hexPubkey, record.service), { record, validatedAt: stamp })
    this.prune()
    this.flush()
  }

  delete(hexPubkey: string, service: string): void {
    this.load()
    if (this.entries.delete(keyOf(hexPubkey, service))) this.flush()
  }

  clear(): void {
    this.entries.clear()
    this.loaded = true
    this.flush()
  }

  size(): number {
    this.load()
    return this.entries.size
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true

    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CacheFile>
      if (parsed.version !== CACHE_VERSION || !parsed.entries) return
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (isEntry(entry)) this.entries.set(key, entry)
      }
      this.prune()
    } catch (error) {
      console.warn('[cache] ignoring unreadable locator cache:', error)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.record.expiresAt <= now) this.entries.delete(key)
    }
    if (this.entries.size <= this.maxEntries) return

    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].record.expiresAt - b[1].record.expiresAt
    )
    const excess = this.entries.size - this.maxEntries
    for (let index = 0; index < excess; index += 1) {
      this.entries.delete(sorted[index][0])
    }
  }

  private flush(): void {
    const payload: CacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries)
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[cache] could not write locator cache:', error)
    }
  }
}
