/**
 * Pure password-vault helpers shared by main and tests.
 *
 * The vault is one NIP-78 event whose content is NIP-44 encrypted to the user's
 * own identity. Nothing in this module touches Electron or the network.
 */

import type { PasswordEntry, PasswordPage, PasswordSummary } from './types'

export const PASSWORD_VAULT_KIND = 30078
export const PASSWORD_VAULT_VERSION = 1
export const PASSWORD_VAULT_D = 'ncc-browser/passwords/v1'
export const PASSWORD_VAULT_TAG = 'ncc-browser/passwords'
export const PASSWORD_VAULT_CLIENT = 'ncc-browser'
/** Keep the plaintext under typical 64 KB relay event limits after NIP-44/base64. */
export const MAX_VAULT_BYTES = 40_000

export const MAX_TITLE = 200
export const MAX_USERNAME = 320
export const MAX_PASSWORD = 4096
export const MAX_NOTES = 4096
export const MAX_TOTP = 2048
export const MAX_ORIGIN = 2048

export interface PasswordVault {
  v: typeof PASSWORD_VAULT_VERSION
  updatedAt: number
  entries: PasswordEntry[]
}

export interface PageOrigin {
  /** Canonical value stored with entries. */
  origin: string
  scheme: 'https' | 'http' | 'ncc'
  secure: boolean
  host: string
  service?: string
}

/** The same NCC origin label NIP-07 uses. */
export function pageOriginFromUrl(raw: string): PageOrigin | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol === 'ncc:') {
    const pubkey = url.hostname.toLowerCase()
    if (!/^[0-9a-f]{64}$/i.test(pubkey) && !/^npub1[02-9ac-hj-np-z]+$/i.test(pubkey)) {
      return null
    }
    const path = url.pathname.replace(/^\/+/, '')
    const service = path.startsWith('_/') ? path.slice(2).split('/')[0] : path.split('/')[0]
    return {
      origin: `ncc://${pubkey}/${service || 'addr'}`,
      scheme: 'ncc',
      secure: true,
      host: pubkey,
      service: service || 'addr'
    }
  }

  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return {
      origin: url.origin,
      scheme: url.protocol === 'https:' ? 'https' : 'http',
      secure: url.protocol === 'https:',
      host: url.hostname.toLowerCase()
    }
  }

  return null
}

/** Password management requires HTTPS or the identity-anchored ncc:// scheme. */
export function canUsePasswordOrigin(origin: PageOrigin | null): boolean {
  return origin != null && (origin.scheme === 'https' || origin.scheme === 'ncc')
}

/** True when an NCC page was served without TLS; allowed but warned about. */
export function isPlaintextNcc(page: PasswordPage | null): boolean {
  return (
    page != null &&
    page.mode === 'ncc' &&
    (page.security == null || page.security.transport === 'plaintext')
  )
}

export function normalizeVault(input: unknown): PasswordVault {
  const value = input && typeof input === 'object' ? (input as Partial<PasswordVault>) : {}
  const entries = Array.isArray(value.entries)
    ? value.entries
        .map((entry) => normalizeEntry(entry))
        .filter((entry): entry is PasswordEntry => entry != null)
    : []
  return {
    v: PASSWORD_VAULT_VERSION,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : 0,
    entries
  }
}

export function normalizeEntry(input: unknown): PasswordEntry | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<PasswordEntry>
  if (typeof value.id !== 'string' || !/^[0-9a-f]{16,64}$/i.test(value.id)) return null
  const origin = typeof value.origin === 'string' ? value.origin.trim() : ''
  if (!origin || origin.length > MAX_ORIGIN) return null
  const parsedOrigin = pageOriginFromUrl(origin)
  if (!parsedOrigin || !canUsePasswordOrigin(parsedOrigin)) return null
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : Date.now()
  const updatedAt =
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : createdAt
  return {
    id: value.id.toLowerCase(),
    origin,
    title: clampText(value.title, MAX_TITLE, origin),
    username: clampText(value.username, MAX_USERNAME, ''),
    password: typeof value.password === 'string' ? value.password.slice(0, MAX_PASSWORD) : '',
    notes: clampText(value.notes, MAX_NOTES, ''),
    totp: clampText(value.totp, MAX_TOTP, ''),
    createdAt,
    updatedAt,
    ...(value.deleted === true ? { deleted: true } : {})
  }
}

function clampText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return value.trim().slice(0, max)
}

export function activeEntries(vault: PasswordVault): PasswordEntry[] {
  return vault.entries.filter((entry) => entry.deleted !== true)
}

export function summarize(entry: PasswordEntry): PasswordSummary {
  return {
    id: entry.id,
    origin: entry.origin,
    title: entry.title,
    username: entry.username,
    hasTotp: entry.totp.length > 0,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

export function summarizeVault(vault: PasswordVault): PasswordSummary[] {
  return activeEntries(vault)
    .map(summarize)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
}

/** Merge two vault copies by entry id, newest write wins. */
export function mergeVaults(
  local: PasswordVault,
  remote: PasswordVault
): { vault: PasswordVault; changed: boolean } {
  const byId = new Map<string, PasswordEntry>()
  let changed = false

  for (const entry of local.entries) byId.set(entry.id, entry)
  for (const entry of remote.entries) {
    const existing = byId.get(entry.id)
    if (!existing) {
      byId.set(entry.id, entry)
      changed = true
      continue
    }
    if (entry.updatedAt > existing.updatedAt) {
      byId.set(entry.id, entry)
      changed = true
    }
  }

  const entries = [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
  const updatedAt = entries.reduce((max, entry) => Math.max(max, entry.updatedAt), 0)
  return {
    vault: { v: PASSWORD_VAULT_VERSION, updatedAt, entries },
    changed
  }
}

export function findEntry(vault: PasswordVault, id: string): PasswordEntry | null {
  return vault.entries.find((entry) => entry.id === id) ?? null
}

/** Entries matching an exact origin, newest first. */
export function entriesForOrigin(vault: PasswordVault, origin: string): PasswordEntry[] {
  return activeEntries(vault)
    .filter((entry) => entry.origin === origin)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function findEntryFor(vault: PasswordVault, origin: string, username: string): PasswordEntry | null {
  const normalized = username.trim().toLowerCase()
  return (
    activeEntries(vault).find(
      (entry) => entry.origin === origin && entry.username.toLowerCase() === normalized
    ) ?? null
  )
}

export function vaultByteLength(vault: PasswordVault): number {
  return new TextEncoder().encode(JSON.stringify(vault)).length
}

export function isVaultWithinLimit(vault: PasswordVault): boolean {
  return vaultByteLength(vault) <= MAX_VAULT_BYTES
}

export function passwordVaultFilter(pubkey: string): {
  kinds: number[]
  authors: string[]
  '#d': string[]
  limit: number
} {
  return {
    kinds: [PASSWORD_VAULT_KIND],
    authors: [pubkey],
    '#d': [PASSWORD_VAULT_D],
    limit: 10
  }
}

/** Validate an import/export origin string and normalize it. */
export function normalizeImportedOrigin(raw: string): string | null {
  const value = raw.trim().split(/[\s,]+/)[0] ?? ''
  if (!value) return null
  if (value.startsWith('ncc://')) {
    return pageOriginFromUrl(value)?.origin ?? null
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  const parsed = pageOriginFromUrl(withScheme)
  if (!parsed) return null
  if (parsed.scheme !== 'https' && parsed.scheme !== 'ncc') return null
  return parsed.origin
}
