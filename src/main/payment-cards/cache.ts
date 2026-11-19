import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Event } from 'nostr-tools'

export interface CachedPaymentCardVault { event: Event; pending: boolean; syncedAt: number | null }
interface CacheFile { version: 1; vaults: Record<string, CachedPaymentCardVault> }

/** Stores only signed, encrypted Nostr events; never plaintext card data. */
export class PaymentCardCache {
  private data: CacheFile | null = null
  constructor(private readonly filePath: string) {}

  get(pubkey: string): CachedPaymentCardVault | null {
    const value = this.load().vaults[pubkey]
    return value && isEvent(value.event) ? value : null
  }

  set(pubkey: string, value: CachedPaymentCardVault): void {
    const data = this.load()
    data.vaults[pubkey] = value
    this.write(data)
  }

  private load(): CacheFile {
    if (this.data) return this.data
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CacheFile>
      if (parsed?.vaults && typeof parsed.vaults === 'object') {
        this.data = { version: 1, vaults: parsed.vaults as Record<string, CachedPaymentCardVault> }
        return this.data
      }
    } catch { /* A corrupt cache can be rebuilt from relays. */ }
    this.data = { version: 1, vaults: {} }
    return this.data
  }

  private write(data: CacheFile): void {
    this.data = data
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(data)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
  }
}

function isEvent(value: unknown): value is Event {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<Event>
  return event.kind === 30078 && typeof event.id === 'string' && typeof event.pubkey === 'string' &&
    typeof event.created_at === 'number' && typeof event.content === 'string' && Array.isArray(event.tags)
}
