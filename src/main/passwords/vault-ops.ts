import { randomBytes } from 'node:crypto'
import { verifyEvent, type Event } from 'nostr-tools'
import {
  PASSWORD_VAULT_KIND,
  PASSWORD_VAULT_VERSION,
  activeEntries,
  findEntryFor,
  normalizeImportedOrigin,
  type PasswordEntry,
  type PasswordVault
} from '@shared/passwords'
import { MAX_VAULT_PARTS, vaultPartIndex } from '@shared/password-parts'
import type { ImportedRow } from './import-export'
import { normalizeTotpInput } from './totp'

export const VAULT_ERROR = 'The password vault could not be read'
export const MAX_EVENT_CONTENT = 1_000_000

export function emptyVault(): PasswordVault {
  return { v: PASSWORD_VAULT_VERSION, updatedAt: 0, entries: [] }
}

/** True when the local copy has an entry the remote lacks or a newer version. */
export function hasLocalChanges(local: PasswordVault, remote: PasswordVault): boolean {
  for (const entry of local.entries) {
    const match = remote.entries.find((candidate) => candidate.id === entry.id)
    if (!match || entry.updatedAt > match.updatedAt || (entry.favoriteUpdatedAt ?? 0) > (match.favoriteUpdatedAt ?? 0)) return true
  }
  return false
}

export function summary(entry: PasswordEntry) {
  return {
    id: entry.id,
    origin: entry.origin,
    title: entry.title,
    username: entry.username,
    hasTotp: entry.totp.length > 0,
    ...(entry.passkey ? { isPasskey: true } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    favorite: entry.favorite === true
  }
}

export function applyEntry(vault: PasswordVault, entry: PasswordEntry): PasswordVault {
  const entries = vault.entries.filter((candidate) => candidate.id !== entry.id)
  entries.push(entry)
  return {
    v: PASSWORD_VAULT_VERSION,
    updatedAt: Math.max(vault.updatedAt, entry.updatedAt),
    entries
  }
}

export function toRow(entry: PasswordEntry): ImportedRow {
  return {
    title: entry.title,
    origin: entry.origin,
    username: entry.username,
    password: entry.password,
    notes: entry.notes,
    totp: entry.totp
  }
}

export function applyRows(
  vault: PasswordVault,
  rows: ImportedRow[],
  now: number,
  mode: 'merge' | 'skip' | 'add'
): PasswordVault {
  let next = vault
  for (const row of rows) {
    const origin = normalizeImportedOrigin(row.origin)
    if (!origin) continue
    const existing = findEntryFor(next, origin, row.username)
    if (existing && mode !== 'add') {
      if (mode === 'skip') continue
      next = applyEntry(next, {
        ...existing,
        title: row.title || existing.title,
        password: row.password,
        notes: row.notes || existing.notes,
        totp: row.totp ? safeTotp(row.totp) : existing.totp,
        updatedAt: now
      })
      continue
    }
    next = applyEntry(next, {
      id: randomBytes(8).toString('hex'),
      origin,
      title: row.title || origin,
      username: row.username,
      password: row.password,
      notes: row.notes,
      totp: safeTotp(row.totp),
      createdAt: now,
      updatedAt: now
    })
  }
  return next
}

export function applyVaultImport(
  vault: PasswordVault,
  imported: PasswordVault,
  now: number,
  mode: 'merge' | 'skip' | 'add'
): PasswordVault {
  let next = vault
  for (const entry of activeEntries(imported)) {
    const existing = findEntryFor(next, entry.origin, entry.username)
    if (existing && mode !== 'add') {
      if (mode === 'skip') continue
      next = applyEntry(next, {
        ...entry,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now
      })
      continue
    }
    next = applyEntry(next, {
      ...entry,
      id: mode === 'add' ? randomBytes(8).toString('hex') : entry.id,
      updatedAt: now
    })
  }
  return next
}

export const VAULT_EXPORT_FORMAT = 'ncc-password-vault'

/** An encrypted export: one vault event, or a bundle with one event per part. */
export function parseExport(text: string): Event[] {
  const parsed = JSON.parse(text) as { format?: unknown; events?: unknown } | null
  if (parsed?.format !== VAULT_EXPORT_FORMAT) return [checkVaultEvent(parsed)]
  const events = parsed.events
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_VAULT_PARTS) {
    throw new Error('That file is not an encrypted password vault')
  }
  return events.map(checkVaultEvent)
}

function checkVaultEvent(input: unknown): Event {
  const parsed = input as Partial<Event> | null
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.kind !== PASSWORD_VAULT_KIND ||
    typeof parsed.pubkey !== 'string' ||
    typeof parsed.content !== 'string' ||
    typeof parsed.created_at !== 'number' ||
    !Array.isArray(parsed.tags) ||
    typeof parsed.sig !== 'string' ||
    typeof parsed.id !== 'string'
  ) {
    throw new Error('That file is not an encrypted password vault')
  }
  const event = parsed as Event
  if (vaultPartIndex(event.tags) === null) {
    throw new Error('That file is not a password vault event')
  }
  if (!verifyEvent(event)) throw new Error('The vault event signature is invalid')
  return event
}

export function trimRelay(url: string): string {
  return url.replace(/\/$/, '')
}

export function safeTotp(value: string): string {
  try {
    return normalizeTotpInput(value)
  } catch {
    return ''
  }
}
