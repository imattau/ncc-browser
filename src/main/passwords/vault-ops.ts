import { randomBytes } from 'node:crypto'
import { verifyEvent, type Event } from 'nostr-tools'
import {
  PASSWORD_VAULT_D,
  PASSWORD_VAULT_KIND,
  PASSWORD_VAULT_VERSION,
  activeEntries,
  findEntryFor,
  normalizeImportedOrigin,
  type PasswordEntry,
  type PasswordVault
} from '@shared/passwords'
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

export function parseEvent(text: string): Event {
  const parsed = JSON.parse(text) as Partial<Event>
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
  if (!event.tags.some((tag) => tag[0] === 'd' && tag[1] === PASSWORD_VAULT_D)) {
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
