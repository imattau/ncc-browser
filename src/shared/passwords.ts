/**
 * Pure password-vault helpers shared by main and tests.
 *
 * The vault is one NIP-78 event whose content is NIP-44 encrypted to the user's
 * own identity. Nothing in this module touches Electron or the network.
 */

import { parseNccAddress } from './ncc-url'
import { parseNsiteAddress } from './nsite-url'
import type { PageMode, TabKind } from './types/base'
import type { IdentityMode } from './types/identity'
import type { SecurityInfo } from './types/ncc'

/* ------------------------------------------------------------------ */
/*  Data model                                                        */
/* ------------------------------------------------------------------ */

/** One decrypted credential. Never exposed to page content. */
export interface PasswordEntry {
  id: string
  /** Normalized page origin: https://host[:port] or ncc://<pubkey>/<service>. */
  origin: string
  title: string
  username: string
  password: string
  notes: string
  /** Base32 secret or otpauth:// URI. Empty when the entry has no TOTP. */
  totp: string
  createdAt: number
  updatedAt: number
  /** Tombstone entries stay in the vault so deletions propagate across devices. */
  deleted?: boolean
  /** A WebAuthn credential. Private key material is protected by the encrypted vault. */
  passkey?: PasskeyCredential
}

export interface PasskeyCredential {
  credentialId: string
  rpId: string
  userHandle: string
  userName: string
  userDisplayName: string
  privateKeyJwk: JsonWebKey
  publicKeyJwk: JsonWebKey
  signCount: number
  discoverable: boolean
}

/** Editable fields sent from the trusted chrome renderer. */
export interface PasswordDraft {
  id?: string
  origin: string
  title: string
  username: string
  password: string
  notes: string
  totp: string
}

/** Metadata safe to list in the toolbar and settings without revealing passwords. */
export interface PasswordSummary {
  id: string
  origin: string
  title: string
  username: string
  hasTotp: boolean
  isPasskey?: boolean
  createdAt: number
  updatedAt: number
}

export interface PasskeyConfirmationRequest {
  id: string
  site: string
  accounts: string[]
  action: 'Create passkey' | 'Use passkey'
}

export interface PasswordConfig {
  /** 0 disables automatic locking for this session. */
  autoLockMinutes: number
  offerSave: boolean
  useNip65: boolean
  /** When set, the vault uses only this relay and skips browser/NIP-65 relays. */
  vaultRelay: string
  /** Origins the user chose never to save for. */
  neverSave: string[]
  /** Allow checkout card-save prompts. */
  offerPaymentCardSave: boolean
  /** Show payment-card autofill suggestions on supported devices. */
  fillPaymentCards: boolean
  /** Opt in to capturing, storing, and autofilling card security codes. */
  savePaymentCardSecurityCodes: boolean
  /** Allow Nostr signer confirmation as an alternative to system authentication. */
  allowNostrPaymentCardAuth: boolean
  /** Make Nostr signer confirmation the default when card autofill is requested. */
  defaultNostrPaymentCardAuth: boolean
}

export const DEFAULT_PASSWORD_CONFIG: PasswordConfig = {
  autoLockMinutes: 15,
  offerSave: true,
  useNip65: true,
  vaultRelay: '',
  neverSave: [],
  offerPaymentCardSave: true,
  fillPaymentCards: true,
  savePaymentCardSecurityCodes: false,
  allowNostrPaymentCardAuth: false,
  defaultNostrPaymentCardAuth: false
}

export function normalizePasswordConfig(input: unknown): PasswordConfig {
  const value = input && typeof input === 'object' ? (input as Partial<PasswordConfig>) : {}
  const minutes =
    typeof value.autoLockMinutes === 'number' && Number.isFinite(value.autoLockMinutes)
      ? Math.max(0, Math.min(24 * 60, Math.round(value.autoLockMinutes)))
      : DEFAULT_PASSWORD_CONFIG.autoLockMinutes
  const vaultRelay =
    typeof value.vaultRelay === 'string' ? value.vaultRelay.trim().slice(0, 2048) : ''
  return {
    autoLockMinutes: minutes,
    offerSave: typeof value.offerSave === 'boolean' ? value.offerSave : true,
    useNip65: typeof value.useNip65 === 'boolean' ? value.useNip65 : true,
    vaultRelay:
      vaultRelay.startsWith('ws://') || vaultRelay.startsWith('wss://') ? vaultRelay : '',
    neverSave: Array.isArray(value.neverSave)
      ? value.neverSave
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .slice(-200)
      : [],
    offerPaymentCardSave: typeof value.offerPaymentCardSave === 'boolean' ? value.offerPaymentCardSave : true,
    fillPaymentCards: typeof value.fillPaymentCards === 'boolean' ? value.fillPaymentCards : true,
    savePaymentCardSecurityCodes: typeof value.savePaymentCardSecurityCodes === 'boolean' ? value.savePaymentCardSecurityCodes : false,
    allowNostrPaymentCardAuth: value.allowNostrPaymentCardAuth === true,
    defaultNostrPaymentCardAuth: value.allowNostrPaymentCardAuth === true && value.defaultNostrPaymentCardAuth === true
  }
}

export type PasswordRelaySource = 'dedicated' | 'browser' | 'browser+nip65'

export interface PasswordVaultStatus {
  /** An identity exists and can encrypt/decrypt. */
  configured: boolean
  available: boolean
  unlocked: boolean
  entryCount: number
  pending: boolean
  syncing: boolean
  lastSyncedAt: number | null
  relays: string[]
  relaySource: PasswordRelaySource
  mode: IdentityMode
  error: string | null
  autoLockMinutes: number
  offerSave: boolean
  useNip65: boolean
  vaultRelay: string
  neverSave: string[]
}

export interface PasswordContext {
  origin: string | null
  title: string
  secure: boolean
  scheme: 'https' | 'http' | 'ncc' | 'nsite' | null
  tabKind: TabKind
  locked: boolean
  configured: boolean
  status: PasswordVaultStatus
  matches: PasswordSummary[]
  passkeys: PasswordSummary[]
  formDetected: boolean
  pendingSave: boolean
  canFill: boolean
  canSave: boolean
  warning: string | null
}

export interface PasswordSaveRequest {
  id: string
  origin: string
  title: string
  username: string
  mode: 'create' | 'update'
  existingId?: string
  secure: boolean
  tabKind: TabKind
  locked: boolean
}

export interface PasswordSaveResult {
  ok: boolean
  error?: string
  status?: PasswordVaultStatus
  pending?: boolean
  path?: string
}

export interface PasswordFillResult {
  ok: boolean
  error?: string
}

export interface PasswordCopyResult {
  ok: boolean
  error?: string
  clearsAt?: number
}

export interface PasswordTotpCode {
  code: string
  remaining: number
  period: number
}

export interface PasswordGeneratorOptions {
  length?: number
  uppercase?: boolean
  lowercase?: boolean
  digits?: boolean
  symbols?: boolean
  avoidAmbiguous?: boolean
}

export interface PasswordImportPreview {
  id: string
  cancelled?: boolean
  format: 'chrome' | 'bitwarden' | 'ncc' | 'encrypted'
  count: number
  duplicates: number
  projectedBytes: number
  entries: Array<{ title: string; origin: string; username: string }>
  error?: string
}

export interface PasswordExportResult {
  ok: boolean
  path?: string
  error?: string
}

export interface PasswordToast {
  tone: 'ok' | 'warn' | 'error'
  message: string
}

/** Main-process view of the active tab, handed to the password service. */
export interface PasswordPage {
  tabId: string
  kind: TabKind
  mode: PageMode
  url: string
  displayUrl: string
  title: string
  security: SecurityInfo | null
}

/* ------------------------------------------------------------------ */
/*  Vault                                                             */
/* ------------------------------------------------------------------ */

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
  scheme: 'https' | 'http' | 'ncc' | 'nsite'
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
    try {
      const parsed = parseNccAddress(raw)
      return {
        origin: `ncc://${parsed.pubkey}/${parsed.service}`,
        scheme: 'ncc',
        secure: true,
        host: parsed.pubkey,
        service: parsed.service
      }
    } catch {
      return null
    }
  }

  if (url.protocol === 'nsite:') {
    try {
      const parsed = parseNsiteAddress(raw)
      const label = parsed.site ? `nsite://${parsed.pubkey}/${parsed.site}` : `nsite://${parsed.pubkey}`
      return {
        origin: label,
        scheme: 'nsite',
        secure: true,
        host: parsed.pubkey,
        ...(parsed.site ? { service: parsed.site } : {})
      }
    } catch {
      return null
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

/** Password management requires HTTPS or an identity-anchored social address. */
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
  const passkey = normalizePasskey(value.passkey)
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
    ...(value.deleted === true ? { deleted: true } : {}),
    ...(passkey ? { passkey } : {})
  }
}

function normalizePasskey(input: unknown): PasskeyCredential | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<PasskeyCredential>
  const privateKeyJwk = value.privateKeyJwk
  const publicKeyJwk = value.publicKeyJwk
  if (typeof value.credentialId !== 'string' || !/^[A-Za-z0-9_-]{20,1024}$/.test(value.credentialId)) return null
  if (typeof value.rpId !== 'string' || value.rpId.length > 253 || !/^[a-z0-9.-]+$/i.test(value.rpId)) return null
  if (typeof value.userHandle !== 'string' || value.userHandle.length > 1024) return null
  if (!isEcJwk(privateKeyJwk, true) || !isEcJwk(publicKeyJwk, false)) return null
  return {
    credentialId: value.credentialId,
    rpId: value.rpId.toLowerCase(),
    userHandle: value.userHandle,
    userName: clampText(value.userName, MAX_USERNAME, ''),
    userDisplayName: clampText(value.userDisplayName, MAX_TITLE, ''),
    privateKeyJwk,
    publicKeyJwk,
    signCount: Number.isSafeInteger(value.signCount) && (value.signCount as number) >= 0 ? value.signCount as number : 0,
    discoverable: value.discoverable === true
  }
}

function isEcJwk(value: unknown, privateKey: boolean): value is JsonWebKey {
  if (!value || typeof value !== 'object') return false
  const jwk = value as JsonWebKey
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' && (!privateKey || typeof jwk.d === 'string')
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
    ...(entry.passkey ? { isPasskey: true } : {}),
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
      (entry) => !entry.passkey && entry.origin === origin && entry.username.toLowerCase() === normalized
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
