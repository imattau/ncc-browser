import { normalizeImportedOrigin } from '@shared/passwords'
import type { PasswordEntry } from '@shared/passwords'
import type { PasswordImportPreview } from '@shared/passwords'

export interface ImportedRow {
  title: string
  origin: string
  username: string
  password: string
  notes: string
  totp: string
}

export interface ParsedImport {
  format: 'chrome' | 'bitwarden' | 'ncc' | 'encrypted'
  rows: ImportedRow[]
  skipped: number
}

/** RFC 4180-style parser: quoted fields, doubled quotes and embedded newlines. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (character !== '\r') {
      field += character
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((value) => value.trim().length > 0))
}

export function parsePasswordCsv(input: string): ParsedImport {
  const rows = parseCsv(input)
  if (rows.length === 0) throw new Error('The file is empty')
  const headers = rows[0].map((header) => header.trim().toLowerCase())
  const format = detectFormat(headers)
  const index = (...names: string[]): number =>
    names.map((name) => headers.indexOf(name)).find((value) => value >= 0) ?? -1

  const columns = {
    title: index('name', 'title'),
    origin: index('login_uri', 'url', 'origin', 'website'),
    username: index('login_username', 'username', 'user'),
    password: index('login_password', 'password'),
    notes: index('notes', 'note'),
    totp: index('login_totp', 'totp', 'otp', 'otpauth')
  }
  if (columns.password < 0) throw new Error('No password column was found')

  const result: ImportedRow[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const rawOrigin = columns.origin >= 0 ? (row[columns.origin] ?? '').split(/\r?\n/)[0] : ''
    const origin = normalizeImportedOrigin(rawOrigin)
    const password = columns.password >= 0 ? (row[columns.password] ?? '') : ''
    if (!origin || !password) {
      skipped += 1
      continue
    }
    const title = (columns.title >= 0 ? row[columns.title] : '')?.trim() || origin
    result.push({
      title: title.slice(0, 200),
      origin,
      username: (columns.username >= 0 ? row[columns.username] : '')?.trim().slice(0, 320) ?? '',
      password: password.slice(0, 4096),
      notes: (columns.notes >= 0 ? row[columns.notes] : '')?.trim().slice(0, 4096) ?? '',
      totp: (columns.totp >= 0 ? row[columns.totp] : '')?.trim().slice(0, 2048) ?? ''
    })
  }
  return { format, rows: result, skipped }
}

function detectFormat(headers: string[]): 'chrome' | 'bitwarden' | 'ncc' {
  if (headers.includes('login_uri') || headers.includes('login_password')) return 'bitwarden'
  if (headers.includes('origin') && headers.includes('title')) return 'ncc'
  return 'chrome'
}

export function csvCell(value: string): string {
  // Spreadsheet applications treat these prefixes as formulas.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
  return csvQuote(safe)
}

/** Secrets must round-trip exactly, so never prefix them with an apostrophe. */
function csvSecret(value: string): string {
  return csvQuote(value)
}

function csvQuote(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function exportPasswordCsv(entries: PasswordEntry[]): string {
  const header = ['name', 'url', 'username', 'password', 'notes', 'totp']
  const lines = [header.join(',')]
  for (const entry of entries.filter((value) => !value.passkey)) {
    lines.push(
      [
        csvCell(entry.title),
        csvCell(entry.origin),
        csvCell(entry.username),
        csvSecret(entry.password),
        csvCell(entry.notes),
        csvSecret(entry.totp)
      ].join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

export function previewRows(
  id: string,
  format: 'chrome' | 'bitwarden' | 'ncc' | 'encrypted',
  rows: ImportedRow[],
  existing: PasswordEntry[],
  projectedBytes: number,
  skipped = 0,
  error?: string
): PasswordImportPreview {
  const keys = new Set(
    existing
      .filter((entry) => entry.deleted !== true)
      .map((entry) => `${entry.origin}\u0000${entry.username.toLowerCase()}`)
  )
  return {
    id,
    format,
    count: rows.length,
    duplicates: rows.filter((row) => keys.has(`${row.origin}\u0000${row.username.toLowerCase()}`))
      .length,
    projectedBytes,
    entries: rows.slice(0, 50).map((row) => ({
      title: row.title,
      origin: row.origin,
      username: row.username
    })),
    ...(skipped > 0 ? { error: `${skipped} row(s) had no usable URL or password and were skipped.` } : {}),
    ...(error ? { error } : {})
  }
}
