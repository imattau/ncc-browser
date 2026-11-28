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

/** Explicitly permissioned ceiling that keeps the current whole-file store bounded. */
export const LARGE_LOCAL_QUOTA_BYTES = 128 * 1024 * 1024

/**
 * One area's values with each entry's JSON kept beside it. A write then only encodes
 * what changed, instead of the whole store, on the main process.
 */
interface AreaState {
  values: StorageValues
  encoded: Map<string, Encoded>
}

interface Encoded {
  /** The entry as it appears inside the stored object: `"name":json`. */
  text: string
  bytes: number
}

export class ExtensionStorage {
  private readonly memory = new Map<string, AreaState>()
  private readonly cache = new Map<string, AreaState>()

  constructor(private readonly baseDir: string) {}

  get(id: string, area: ExtensionStorageArea, keys: unknown): StorageValues {
    const { values } = this.read(id, area)
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
    values: unknown,
    allowLargeLocalStorage = false
  ): { changes: StorageChanges; error?: string } {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return { changes: {}, error: 'storage.set expects an object' }
    }
    const current = this.read(id, area)
    const next: AreaState = { values: { ...current.values }, encoded: new Map(current.encoded) }
    const changes: StorageChanges = {}
    try {
      for (const [key, value] of Object.entries(values as StorageValues)) {
        if (value === undefined) continue
        const entry = encode(key, value)
        // Writing back what is already stored is not a change.
        if (entry && entry.text === current.encoded.get(key)?.text) continue
        changes[key] = {
          ...(key in current.values ? { oldValue: current.values[key] } : {}),
          newValue: value
        }
        next.values[key] = value
        if (entry) next.encoded.set(key, entry)
        else next.encoded.delete(key)
      }
    } catch {
      return { changes: {}, error: 'storage.set values must be JSON-serialisable' }
    }
    if (Object.keys(changes).length === 0) return { changes }
    const quota = area === 'local' && allowLargeLocalStorage
      ? LARGE_LOCAL_QUOTA_BYTES
      : QUOTAS[area]
    if (storedBytes(next) > quota) {
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
    const next: AreaState = { values: { ...current.values }, encoded: new Map(current.encoded) }
    const changes: StorageChanges = {}
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []
    for (const key of list) {
      if (typeof key !== 'string' || !(key in next.values)) continue
      changes[key] = { oldValue: next.values[key] }
      delete next.values[key]
      next.encoded.delete(key)
    }
    if (Object.keys(changes).length > 0) this.write(id, area, next)
    return { changes }
  }

  clear(id: string, area: ExtensionStorageArea): { changes: StorageChanges } {
    const current = this.read(id, area)
    const changes: StorageChanges = {}
    for (const [key, value] of Object.entries(current.values)) changes[key] = { oldValue: value }
    this.write(id, area, emptyState())
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

  private read(id: string, area: ExtensionStorageArea): AreaState {
    const key = cacheKey(id, area)
    if (area === 'session' || area === 'private') {
      return this.memory.get(key) ?? emptyState()
    }
    const cached = this.cache.get(key)
    if (cached) return cached
    const state = emptyState()
    const path = this.pathFor(id, area)
    if (existsSync(path)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      } catch {
        throw new Error(`storage.${area} data is corrupt or unreadable; existing data was left untouched`)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`storage.${area} data has an invalid format; existing data was left untouched`)
      }
      state.values = parsed as StorageValues
      for (const [name, value] of Object.entries(state.values)) {
        const entry = encode(name, value)
        if (entry) state.encoded.set(name, entry)
      }
    }
    this.cache.set(key, state)
    return state
  }

  private write(id: string, area: ExtensionStorageArea, state: AreaState): void {
    const key = cacheKey(id, area)
    if (area === 'session' || area === 'private') {
      this.memory.set(key, state)
      return
    }
    const path = this.pathFor(id, area)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    const body = Array.from(state.encoded.values(), (entry) => entry.text).join(',')
    writeFileSync(tmp, `{${body}}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    // Only after the write: a failed one must not be remembered as saved.
    this.cache.set(key, state)
  }

  private pathFor(id: string, area: ExtensionStorageArea): string {
    return join(this.baseDir, id, `storage-${area}.json`)
  }
}

function cacheKey(id: string, area: ExtensionStorageArea): string {
  return `${id}:${area}`
}

function emptyState(): AreaState {
  return { values: {}, encoded: new Map() }
}

/** Null for values JSON leaves out of an object, such as functions. Throws for BigInt. */
function encode(name: string, value: unknown): Encoded | null {
  const json = JSON.stringify(value) as string | undefined
  if (json === undefined) return null
  const text = `${JSON.stringify(name)}:${json}`
  return { text, bytes: Buffer.byteLength(text, 'utf8') }
}

/** The size of the stored object: its braces, its entries and the commas between. */
function storedBytes(state: AreaState): number {
  let total = 2 + Math.max(0, state.encoded.size - 1)
  for (const entry of state.encoded.values()) total += entry.bytes
  return total
}
