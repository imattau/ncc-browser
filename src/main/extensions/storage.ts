/**
 * Per-extension storage areas. `local`/`sync` live on disk next to the installed
 * package; `session` lives for the app session; `private` is cleared when the last
 * private tab closes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionStorageArea } from '@shared/extensions'

export type StorageValues = Record<string, unknown>

export interface StorageChange {
  oldValue?: unknown
  newValue?: unknown
}

export interface StorageChanges {
  [key: string]: StorageChange
}

const QUOTAS: Record<ExtensionStorageArea, number> = {
  local: 10 * 1024 * 1024,
  sync: 5 * 1024 * 1024,
  session: 1024 * 1024,
  private: 1024 * 1024
}

export class ExtensionStorage {
  private readonly memory = new Map<string, StorageValues>()
  private readonly cache = new Map<string, StorageValues>()

  constructor(private readonly baseDir: string) {}

  get(id: string, area: ExtensionStorageArea, keys: unknown): StorageValues {
    const values = this.read(id, area)
    if (keys == null) return { ...values }
    if (typeof keys === 'string') {
      return keys in values ? { [keys]: values[keys] } : {}
    }
    if (Array.isArray(keys)) {
      const result: StorageValues = {}
      for (const key of keys) {
        if (typeof key === 'string' && key in values) result[key] = values[key]
      }
      return result
    }
    if (typeof keys === 'object') {
      const result: StorageValues = {}
      for (const [key, fallback] of Object.entries(keys as StorageValues)) {
        result[key] = key in values ? values[key] : fallback
      }
      return result
    }
    return {}
  }

  set(
    id: string,
    area: ExtensionStorageArea,
    values: unknown
  ): { changes: StorageChanges; error?: string } {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return { changes: {}, error: 'storage.set expects an object' }
    }
    const current = this.read(id, area)
    const next = { ...current }
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(values as StorageValues)) {
      if (value === undefined) continue
      changes[key] = { ...(key in current ? { oldValue: current[key] } : {}), newValue: value }
      next[key] = value
    }
    let size: number
    try {
      size = byteLength(next)
    } catch {
      return { changes: {}, error: 'storage.set values must be JSON-serialisable' }
    }
    if (size > QUOTAS[area]) {
      return { changes: {}, error: `storage.${area} quota exceeded` }
    }
    this.write(id, area, next)
    return { changes }
  }

  remove(
    id: string,
    area: ExtensionStorageArea,
    keys: unknown
  ): { changes: StorageChanges } {
    const current = this.read(id, area)
    const next = { ...current }
    const changes: StorageChanges = {}
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []
    for (const key of list) {
      if (typeof key !== 'string' || !(key in next)) continue
      changes[key] = { oldValue: next[key] }
      delete next[key]
    }
    this.write(id, area, next)
    return { changes }
  }

  clear(id: string, area: ExtensionStorageArea): { changes: StorageChanges } {
    const current = this.read(id, area)
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(current)) changes[key] = { oldValue: value }
    this.write(id, area, {})
    return { changes }
  }

  clearPrivate(): void {
    for (const key of [...this.memory.keys()]) {
      if (key.endsWith(':private')) this.memory.delete(key)
    }
  }

  removeExtension(id: string): void {
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(`${id}:`)) this.memory.delete(key)
    }
    for (const area of ['local', 'sync'] as const) {
      this.cache.delete(cacheKey(id, area))
    }
  }

  private read(id: string, area: ExtensionStorageArea): StorageValues {
    const key = cacheKey(id, area)
    if (area === 'session' || area === 'private') {
      return { ...(this.memory.get(key) ?? {}) }
    }
    const cached = this.cache.get(key)
    if (cached) return { ...cached }
    const path = this.pathFor(id, area)
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const values = parsed as StorageValues
          this.cache.set(key, values)
          return { ...values }
        }
      }
    } catch {
      // A corrupt storage file is better treated as empty than crashing the page.
    }
    this.cache.set(key, {})
    return {}
  }

  private write(id: string, area: ExtensionStorageArea, values: StorageValues): void {
    const key = cacheKey(id, area)
    if (area === 'session' || area === 'private') {
      this.memory.set(key, { ...values })
      return
    }
    this.cache.set(key, { ...values })
    const path = this.pathFor(id, area)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(values)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  }

  private pathFor(id: string, area: ExtensionStorageArea): string {
    return join(this.baseDir, id, `storage-${area}.json`)
  }
}

function cacheKey(id: string, area: ExtensionStorageArea): string {
  return `${id}:${area}`
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
