import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Event } from 'nostr-tools'

export interface CachedVault {
  /** The latest signed kind 30078 event. The content is already encrypted. */
  event: Event
  pending: boolean
  syncedAt: number | null
}

interface CacheFile {
  version: 1
  vaults: Record<string, CachedVault>
  migratedFrom?: Record<string, string[]>
}

/**
 * Ciphertext-only local cache. Keeping the signed event lets the vault unlock
 * offline for local identities without ever writing a plaintext password to disk.
 */
export class PasswordCache {
  private data: CacheFile | null = null

  constructor(private readonly filePath: string) {}

  get(pubkey: string): CachedVault | null {
    const value = this.load().vaults[pubkey]
    if (!value || !isEvent(value.event)) return null
    return value
  }

  set(pubkey: string, value: CachedVault): void {
    const data = this.load()
    data.vaults[pubkey] = value
    this.write(data)
  }

  clear(pubkey: string): void {
    const data = this.load()
    if (!data.vaults[pubkey]) return
    delete data.vaults[pubkey]
    this.write(data)
  }

  migratedSources(defaultPubkey: string): string[] {
    const value = this.load().migratedFrom?.[defaultPubkey]
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  }

  markSourceMigrated(defaultPubkey: string, sourcePubkey: string): void {
    const data = this.load()
    const sources = data.migratedFrom ?? (data.migratedFrom = {})
    const migrated = sources[defaultPubkey] ?? (sources[defaultPubkey] = [])
    if (migrated.includes(sourcePubkey)) return
    migrated.push(sourcePubkey)
    this.write(data)
  }

  private load(): CacheFile {
    if (this.data) return this.data
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CacheFile>
        if (parsed && typeof parsed === 'object' && parsed.vaults && typeof parsed.vaults === 'object') {
          this.data = {
            version: 1,
            vaults: parsed.vaults as Record<string, CachedVault>,
            ...(parsed.migratedFrom && typeof parsed.migratedFrom === 'object'
              ? { migratedFrom: parsed.migratedFrom as Record<string, string[]> }
              : {})
          }
          return this.data
        }
      }
    } catch {
      // A corrupt cache is disposable: the relay copy is authoritative.
    }
    this.data = { version: 1, vaults: {} }
    return this.data
  }

  private write(data: CacheFile): void {
    this.data = data
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.filePath)
  }
}

function isEvent(value: unknown): value is Event {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<Event>
  return (
    event.kind === 30078 &&
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.created_at === 'number' &&
    typeof event.content === 'string' &&
    Array.isArray(event.tags)
  )
}
