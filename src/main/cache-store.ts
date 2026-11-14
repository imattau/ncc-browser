/**
 * Optional on-disk cache for resolved locators.
 *
 * Records are public by construction: plaintext NCC-05 payloads. Encrypted records are
 * deliberately never persisted, so a decrypted private locator cannot be left behind
 * on disk.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ResolvedService } from '@shared/types'

export interface LocatorStore {
  get(hexPubkey: string, service: string): ResolvedService | null
  set(record: ResolvedService): void
  delete(hexPubkey: string, service: string): void
}

interface CacheFile {
  version: 1
  entries: Record<string, ResolvedService>
}

const CACHE_VERSION = 1

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

export class LocatorCacheStore implements LocatorStore {
  private entries = new Map<string, ResolvedService>()
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly maxEntries = 500
  ) {}

  get(hexPubkey: string, service: string): ResolvedService | null {
    this.load()
    const key = keyOf(hexPubkey, service)
    const record = this.entries.get(key)
    if (!record) return null
    if (record.expiresAt <= this.now()) {
      this.entries.delete(key)
      this.flush()
      return null
    }
    return record
  }

  set(record: ResolvedService): void {
    if (record.encrypted) return
    this.load()
    this.entries.set(keyOf(record.hexPubkey, record.service), record)
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
      for (const [key, record] of Object.entries(parsed.entries)) {
        if (isResolvedService(record)) this.entries.set(key, record)
      }
      this.prune()
    } catch (error) {
      console.warn('[cache] ignoring unreadable locator cache:', error)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, record] of this.entries) {
      if (record.expiresAt <= now) this.entries.delete(key)
    }
    if (this.entries.size <= this.maxEntries) return

    const sorted = [...this.entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
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
