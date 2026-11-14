/**
 * Per-origin NIP-07 permissions. An origin is an npub for ncc:// pages, or a normal
 * web origin for clearnet pages. Trusted origins skip the approval dialog.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SignerPermission } from '@shared/types'

interface PermissionFile {
  version: 1
  origins: Record<string, SignerPermission>
}

export class PermissionStore {
  private readonly origins = new Map<string, SignerPermission>()
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 200
  ) {}

  isTrusted(origin: string): boolean {
    this.load()
    return this.origins.get(origin)?.trusted === true
  }

  trust(origin: string, label: string, now = Date.now()): SignerPermission {
    this.load()
    const record: SignerPermission = {
      origin,
      label,
      trusted: true,
      createdAt: this.origins.get(origin)?.createdAt ?? now,
      lastUsedAt: now
    }
    this.origins.set(origin, record)
    this.prune()
    this.flush()
    return record
  }

  touch(origin: string, now = Date.now()): void {
    this.load()
    const record = this.origins.get(origin)
    if (!record) return
    record.lastUsedAt = now
    this.flush()
  }

  revoke(origin: string): void {
    this.load()
    if (this.origins.delete(origin)) this.flush()
  }

  list(): SignerPermission[] {
    this.load()
    return [...this.origins.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  clear(): void {
    this.origins.clear()
    this.loaded = true
    this.flush()
  }

  private prune(): void {
    if (this.origins.size <= this.maxEntries) return
    const sorted = [...this.origins.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const record of sorted.slice(0, this.origins.size - this.maxEntries)) {
      this.origins.delete(record.origin)
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PermissionFile>
      if (parsed.version !== 1 || !parsed.origins) return
      for (const [origin, record] of Object.entries(parsed.origins)) {
        if (
          record &&
          typeof record.origin === 'string' &&
          typeof record.label === 'string' &&
          record.trusted === true
        ) {
          this.origins.set(origin, record)
        }
      }
    } catch (error) {
      console.warn('[signer] ignoring unreadable permission file:', error)
    }
  }

  private flush(): void {
    const payload: PermissionFile = {
      version: 1,
      origins: Object.fromEntries(this.origins)
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[signer] could not write permission file:', error)
    }
  }
}
