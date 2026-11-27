import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import type { SyncCategories, SyncPrefsPatch } from '@shared/sync-status'
import { isDeviceId, mergeIdentityMarks, type IdentityLocalState, type IdentityMark } from '@shared/sync'

export interface SyncPrefs {
  categories: SyncCategories
  deviceId: string
  deviceName: string
  identityVaultOwnerId?: string
  /** What this device remembers about identity removals. */
  identityState: IdentityLocalState
  /** Removals the person chose to keep the key for, by pubkey, so they are not asked again. */
  identityKept: Record<string, number>
}

const FILE_VERSION = 1

/**
 * What to sync and which device this is. Everything is off until the person turns it
 * on: sync publishes encrypted documents to relays, and that should be a choice.
 */
export class SyncPrefsStore {
  private prefs: SyncPrefs | null = null

  constructor(private readonly filePath: string) {}

  get(): SyncPrefs {
    if (this.prefs) return this.prefs
    this.prefs = this.read()
    return this.prefs
  }

  update(patch: SyncPrefsPatch): SyncPrefs {
    const current = this.get()
    const categories = { ...current.categories }
    for (const key of ['bookmarks', 'tabs', 'history', 'identities'] as const) {
      const value = patch.categories?.[key]
      if (typeof value === 'boolean') categories[key] = value
    }
    const name =
      typeof patch.deviceName === 'string' && patch.deviceName.trim()
        ? patch.deviceName.trim().slice(0, 80)
        : current.deviceName
    this.prefs = { ...current, categories, deviceName: name }
    this.write()
    return this.prefs
  }

  setIdentityVaultOwner(id: string | undefined): void {
    const current = this.get()
    this.prefs = { ...current, identityVaultOwnerId: id }
    this.write()
  }

  setIdentityState(state: IdentityLocalState, kept = this.get().identityKept): void {
    this.prefs = { ...this.get(), identityState: state, identityKept: kept }
    this.write()
  }

  private read(): SyncPrefs {
    const fresh: SyncPrefs = {
      categories: { bookmarks: false, tabs: false, history: false, identities: false },
      deviceId: randomBytes(8).toString('hex'),
      deviceName: defaultDeviceName(),
      identityState: { excluded: [], marks: [] },
      identityKept: {}
    }
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<{
          version: number
          categories: Partial<SyncCategories>
          deviceId: string
          deviceName: string
          identityVaultOwnerId?: string
          identityState: unknown
          identityKept: unknown
        }>
        if (parsed.version === FILE_VERSION) {
          return {
            categories: {
              bookmarks: parsed.categories?.bookmarks === true,
              tabs: parsed.categories?.tabs === true,
              history: parsed.categories?.history === true,
              identities: parsed.categories?.identities === true
            },
            deviceId: isDeviceId(parsed.deviceId) ? parsed.deviceId : fresh.deviceId,
            deviceName:
              typeof parsed.deviceName === 'string' && parsed.deviceName.trim()
                ? parsed.deviceName.trim().slice(0, 80)
                : fresh.deviceName,
            identityState: readIdentityState(parsed.identityState),
            identityKept: readKept(parsed.identityKept),
            ...(typeof parsed.identityVaultOwnerId === 'string' ? { identityVaultOwnerId: parsed.identityVaultOwnerId } : {})
          }
        }
      }
    } catch (error) {
      console.warn('[sync] ignoring unreadable sync preferences:', error)
    }
    this.prefs = fresh
    this.write()
    return fresh
  }

  private write(): void {
    if (!this.prefs) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: FILE_VERSION, ...this.prefs }, null, 2)}\n`)
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[sync] could not save sync preferences:', error)
    }
  }
}

const isPubkey = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function readIdentityState(value: unknown): IdentityLocalState {
  const saved = (value ?? {}) as { excluded?: unknown; marks?: unknown }
  const marks = (Array.isArray(saved.marks) ? saved.marks : []).filter(
    (mark): mark is IdentityMark =>
      isPubkey(mark?.pubkey) && typeof mark.removed === 'boolean' && Number.isSafeInteger(mark.at)
  )
  return {
    excluded: Array.isArray(saved.excluded) ? saved.excluded.filter(isPubkey) : [],
    marks: mergeIdentityMarks(marks)
  }
}

function readKept(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => isPubkey(entry[0]) && Number.isSafeInteger(entry[1])
    )
  )
}

function defaultDeviceName(): string {
  const host = hostname().replace(/\.local$/i, '').trim()
  const label = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'
  return host ? `${host} (${label})` : `${label} desktop`
}
