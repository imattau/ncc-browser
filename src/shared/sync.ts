/**
 * Browser data sync: bookmarks, history and open tabs.
 *
 * This is the TypeScript half of `crates/ncc-vault/src/sync.rs`. The two have to agree
 * exactly, and both run `test/fixtures/sync-vectors.json`. See the Rust module for the
 * format and the merge rules; the short version:
 *
 * - bookmarks merge by URL, the newer `updatedAt` wins, a delete is a tombstone;
 * - history merges by URL, newest visit wins, visit count is the larger of the two,
 *   and `clearedBefore` is a watermark that drops everything visited at or before it;
 * - tabs have one writer per device, so there is nothing to merge.
 *
 * Nothing here touches Electron or the network.
 */

import { getPublicKey, nip19 } from 'nostr-tools'

export const SYNC_KIND = 30078
export const SYNC_VERSION = 1
export const SYNC_TAG = 'ncc-browser/sync'
export const SYNC_CLIENT = 'ncc-browser'
export const BOOKMARKS_D = 'ncc-browser/bookmarks/v1'
export const HISTORY_D_PREFIX = 'ncc-browser/history/v1/'
export const TABS_D_PREFIX = 'ncc-browser/tabs/v1/'
export const IDENTITIES_D = 'ncc-browser/identities/v1'

export const MAX_DOC_BYTES = 40_000
export const MAX_URL = 4096
export const MAX_TITLE = 300
export const MAX_BOOKMARKS = 500
export const MAX_TABS = 60
export const MAX_SYNCED_IDENTITIES = 1000
export const HISTORY_WINDOW_WEEKS = 8
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const DEVICE_STALE_MS = 60 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

export interface SyncBookmark {
  url: string
  title: string
  createdAt: number
  updatedAt: number
  deleted?: true
}

export interface BookmarkDoc {
  v: 1
  updatedAt: number
  entries: SyncBookmark[]
}

export interface SyncVisit {
  url: string
  title: string
  visits: number
  lastVisit: number
}

export interface HistoryDoc {
  v: 1
  week: number
  clearedBefore: number
  entries: SyncVisit[]
}

export interface DeviceInfo {
  id: string
  name: string
  platform: string
}

export interface SyncTab {
  url: string
  title: string
  lastActive: number
}

export interface TabsDoc {
  v: 1
  device: DeviceInfo
  updatedAt: number
  tabs: SyncTab[]
  removed?: true
}

export interface SyncedIdentity {
  pubkey: string
  nsec: string
}

/**
 * Whether a key has been taken out of identity sync, or put back. The newer mark for
 * a key wins; at the same moment, removal wins. A removed key is left out of the
 * vault, but no device deletes its own copy because of a mark.
 */
export interface IdentityMark {
  pubkey: string
  removed: boolean
  /** Epoch milliseconds the choice was made. */
  at: number
}

export interface IdentityVaultDoc {
  v: 1
  updatedAt: number
  entries: SyncedIdentity[]
  /** Left out when there are none, which is how older versions write the document. */
  marks?: IdentityMark[]
}

const HEX_KEY = /^[0-9a-f]{64}$/i

export function mergeIdentityMarks(...lists: IdentityMark[][]): IdentityMark[] {
  const marks = new Map<string, IdentityMark>()
  for (const mark of lists.flat()) {
    const current = marks.get(mark.pubkey)
    if (!current || mark.at > current.at || (mark.at === current.at && mark.removed)) {
      marks.set(mark.pubkey, mark)
    }
  }
  return [...marks.values()].sort((a, b) => a.pubkey.localeCompare(b.pubkey))
}

function normalizeIdentityMarks(value: unknown): IdentityMark[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_SYNCED_IDENTITIES) {
    throw new Error('The identity vault has an invalid list of removals.')
  }
  return mergeIdentityMarks(
    value.map((raw) => {
      if (!isRecord(raw) || typeof raw.pubkey !== 'string' || !HEX_KEY.test(raw.pubkey) ||
        typeof raw.removed !== 'boolean' || !isU64(raw.at)) {
        throw new Error('The identity vault contains an invalid removal.')
      }
      return { pubkey: raw.pubkey.toLowerCase(), removed: raw.removed, at: raw.at }
    })
  )
}

/** A vault in canonical form: sorted, with removed keys left out. */
function identityVault(
  updatedAt: number,
  entries: Iterable<SyncedIdentity>,
  marks: IdentityMark[]
): IdentityVaultDoc {
  const removed = new Set(marks.filter((mark) => mark.removed).map((mark) => mark.pubkey))
  return {
    v: 1,
    updatedAt,
    entries: [...entries]
      .filter((entry) => !removed.has(entry.pubkey))
      .sort((a, b) => a.pubkey.localeCompare(b.pubkey)),
    ...(marks.length ? { marks } : {})
  }
}

function collectIdentities(lists: SyncedIdentity[][]): Map<string, SyncedIdentity> {
  const entries = new Map<string, SyncedIdentity>()
  for (const entry of lists.flat()) {
    const existing = entries.get(entry.pubkey)
    if (existing && existing.nsec !== entry.nsec) throw new Error('The identity vault has conflicting keys for one public key.')
    if (!existing) entries.set(entry.pubkey, entry)
  }
  return entries
}

/** The public key an nsec belongs to, or null if it is not a usable one. */
function pubkeyOfNsec(nsec: string): string | null {
  try {
    const decoded = nip19.decode(nsec)
    return decoded.type === 'nsec' ? getPublicKey(decoded.data) : null
  } catch {
    return null
  }
}

export function normalizeIdentityVault(value: unknown, now = 0): IdentityVaultDoc {
  if (value === null || value === undefined) return { v: 1, updatedAt: now, entries: [] }
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_SYNCED_IDENTITIES) {
    throw new Error('The identity vault has an unsupported or invalid format.')
  }
  const parsed = value.entries.map((raw): SyncedIdentity => {
    if (!isRecord(raw) || typeof raw.pubkey !== 'string' || !HEX_KEY.test(raw.pubkey) ||
      typeof raw.nsec !== 'string' || !/^nsec1.{20,90}$/i.test(raw.nsec)) {
      throw new Error('The identity vault contains an invalid key entry.')
    }
    const pubkey = raw.pubkey.toLowerCase()
    // Removals go by public key, so an entry must really be the key it says it is.
    if (pubkeyOfNsec(raw.nsec) !== pubkey) {
      throw new Error('An identity vault key does not match its public key.')
    }
    return { pubkey, nsec: raw.nsec }
  })
  const updatedAt = optionalU64(value.updatedAt)
  if (updatedAt === null) throw new Error('The identity vault timestamp is invalid.')
  return identityVault(
    value.updatedAt === undefined ? now : updatedAt,
    collectIdentities([parsed]).values(),
    normalizeIdentityMarks(value.marks)
  )
}

export function mergeIdentityVaults(local: unknown, remote: unknown, now = 0): IdentityVaultDoc {
  const a = normalizeIdentityVault(local, now)
  const b = normalizeIdentityVault(remote, now)
  return identityVault(
    Math.max(a.updatedAt, b.updatedAt),
    collectIdentities([a.entries, b.entries]).values(),
    mergeIdentityMarks(a.marks ?? [], b.marks ?? [])
  )
}

/** Whether two vaults say the same thing, whenever they were written. */
export function sameIdentityVault(a: IdentityVaultDoc, b: IdentityVaultDoc): boolean {
  const content = (doc: IdentityVaultDoc): string =>
    JSON.stringify([
      doc.entries.map((entry) => [entry.pubkey, entry.nsec]),
      (doc.marks ?? []).map((mark) => [mark.pubkey, mark.removed, mark.at])
    ])
  return content(a) === content(b)
}

/** What one device remembers about identity sync. */
export interface IdentityLocalState {
  /** Keys removed from this device only. They are not imported again. */
  excluded: string[]
  /**
   * Every mark seen or made here. Remembering them puts one back if an older
   * version, which does not know about marks, writes the vault without it.
   */
  marks: IdentityMark[]
}

export interface IdentityPlan {
  /** The vault as it should now be on the relays. */
  doc: IdentityVaultDoc
  /** Keys to save on this device. */
  imports: SyncedIdentity[]
  marks: IdentityMark[]
  /** Excluded keys that are on this device again, so the person has added them back. */
  unexclude: string[]
  /** Keys held here that have been removed from sync. Never deleted without asking. */
  removals: IdentityMark[]
}

export function planIdentitySync(
  local: SyncedIdentity[],
  remote: unknown,
  state: IdentityLocalState,
  now: number
): IdentityPlan {
  const doc = mergeIdentityVaults(
    { v: 1, updatedAt: now, entries: local, ...(state.marks.length ? { marks: state.marks } : {}) },
    remote,
    now
  )
  const held = new Set(local.map((entry) => entry.pubkey))
  const excluded = new Set(state.excluded)
  const marks = doc.marks ?? []
  return {
    doc,
    imports: doc.entries.filter((entry) => !held.has(entry.pubkey) && !excluded.has(entry.pubkey)),
    marks,
    unexclude: state.excluded.filter((pubkey) => held.has(pubkey)),
    removals: marks.filter((mark) => mark.removed && held.has(mark.pubkey))
  }
}

export type DocKind =
  | { kind: 'bookmarks' }
  | { kind: 'identities' }
  | { kind: 'history'; week: number }
  | { kind: 'tabs'; deviceId: string }

type Json = Record<string, unknown>

const encoder = new TextEncoder()

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A non-negative integer, like a Rust `u64` field. */
function isU64(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** `serde(default)` fields: absent is fine, present has to be the right type. */
function optionalU64(value: unknown): number | null {
  if (value === undefined) return 0
  return isU64(value) ? value : null
}

function optionalString(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : null
}

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  const length = Math.min(x.length, y.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0)
    if (difference !== 0) return difference
  }
  return x.length - y.length
}

function clip(value: string, max: number): string {
  const squashed = value.split(/\s+/).filter(Boolean).join(' ')
  return Array.from(squashed).slice(0, max).join('')
}

export function isSyncableUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const value = url.trim()
  if (!value || encoder.encode(value).length > MAX_URL) return false
  return /^(ncc:\/\/|nsite:\/\/|https?:\/\/)/i.test(value)
}

// ───────────────────────────── Bookmarks ─────────────────────────────

function parseBookmark(raw: unknown): SyncBookmark | null {
  if (!isRecord(raw) || typeof raw.url !== 'string') return null
  const title = optionalString(raw.title)
  const createdAt = optionalU64(raw.createdAt)
  const updatedAt = optionalU64(raw.updatedAt)
  if (title === null || createdAt === null || updatedAt === null) return null
  if (raw.deleted !== undefined && typeof raw.deleted !== 'boolean') return null
  return {
    url: raw.url,
    title,
    createdAt,
    updatedAt,
    ...(raw.deleted === true ? { deleted: true as const } : {})
  }
}

function bookmarkWins(a: SyncBookmark, b: SyncBookmark): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt
  const aDeleted = a.deleted === true
  const bDeleted = b.deleted === true
  if (aDeleted !== bDeleted) return aDeleted
  return compareBytes(a.title, b.title) > 0
}

function sortBookmarks(entries: SyncBookmark[]): void {
  entries.sort((a, b) => b.createdAt - a.createdAt || compareBytes(a.url, b.url))
}

function keepBookmark(entry: SyncBookmark, now: number): boolean {
  return !entry.deleted || Math.max(0, now - entry.updatedAt) <= TOMBSTONE_TTL_MS
}

export function emptyBookmarks(): BookmarkDoc {
  return { v: SYNC_VERSION, updatedAt: 0, entries: [] }
}

export function normalizeBookmarks(value: unknown, now: number): BookmarkDoc {
  const byUrl = new Map<string, SyncBookmark>()
  const raw = isRecord(value) && Array.isArray(value.entries) ? value.entries : []
  for (const item of raw) {
    const entry = parseBookmark(item)
    if (!entry || !isSyncableUrl(entry.url)) continue
    entry.url = entry.url.trim()
    entry.title = clip(entry.title, MAX_TITLE) || entry.url
    if (entry.updatedAt === 0) entry.updatedAt = entry.createdAt
    const existing = byUrl.get(entry.url)
    if (!existing || bookmarkWins(entry, existing)) byUrl.set(entry.url, entry)
  }
  const entries = [...byUrl.values()].filter((entry) => keepBookmark(entry, now))
  sortBookmarks(entries)
  const updatedAt = isRecord(value) && isU64(value.updatedAt) ? value.updatedAt : 0
  return { v: SYNC_VERSION, updatedAt, entries }
}

export function mergeBookmarks(local: BookmarkDoc, remote: BookmarkDoc, now: number): BookmarkDoc {
  const merged = new Map<string, SyncBookmark>()
  for (const entry of [...local.entries, ...remote.entries]) {
    const existing = merged.get(entry.url)
    if (!existing || bookmarkWins(entry, existing)) merged.set(entry.url, { ...entry })
  }
  const entries = [...merged.values()].filter((entry) => keepBookmark(entry, now))
  sortBookmarks(entries)
  fitBookmarks(entries)
  return { v: SYNC_VERSION, updatedAt: Math.max(local.updatedAt, remote.updatedAt), entries }
}

/** Make the document fit: tombstones go first, then the oldest bookmarks. */
export function fitBookmarks(entries: SyncBookmark[]): void {
  let live = 0
  const kept = entries.filter((entry) => {
    if (entry.deleted) return true
    live += 1
    return live <= MAX_BOOKMARKS
  })
  entries.splice(0, entries.length, ...kept)
  while (byteLength({ v: SYNC_VERSION, updatedAt: 0, entries }) > MAX_DOC_BYTES) {
    let position = -1
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.deleted) {
        position = index
        break
      }
    }
    if (position >= 0) entries.splice(position, 1)
    else if (entries.pop() === undefined) break
  }
}

// ───────────────────────────── History ─────────────────────────────

/** Weeks start on Monday (UTC); the epoch fell on a Thursday. */
export function weekOf(ms: number): number {
  return Math.floor((Math.floor(ms / DAY_MS) + 3) / 7)
}

export const historyD = (week: number): string => `${HISTORY_D_PREFIX}${week}`

export function parseHistoryD(d: string): number | null {
  if (!d.startsWith(HISTORY_D_PREFIX)) return null
  const rest = d.slice(HISTORY_D_PREFIX.length)
  return /^\d{1,15}$/.test(rest) ? Number(rest) : null
}

export const tabsD = (deviceId: string): string => `${TABS_D_PREFIX}${deviceId}`

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{8,32}$/.test(value)
}

export function parseTabsD(d: string): string | null {
  if (!d.startsWith(TABS_D_PREFIX)) return null
  const id = d.slice(TABS_D_PREFIX.length)
  return isDeviceId(id) ? id : null
}

export function docKind(d: string): DocKind | null {
  if (d === BOOKMARKS_D) return { kind: 'bookmarks' }
  if (d === IDENTITIES_D) return { kind: 'identities' }
  const week = parseHistoryD(d)
  if (week !== null) return { kind: 'history', week }
  const deviceId = parseTabsD(d)
  return deviceId ? { kind: 'tabs', deviceId } : null
}

/** The oldest week that leaves the device. */
export function historyWindowStart(now: number): number {
  return Math.max(0, weekOf(now) - (HISTORY_WINDOW_WEEKS - 1))
}

export function emptyHistory(week: number): HistoryDoc {
  return { v: SYNC_VERSION, week, clearedBefore: 0, entries: [] }
}

function parseVisit(raw: unknown): SyncVisit | null {
  if (!isRecord(raw) || typeof raw.url !== 'string') return null
  const title = optionalString(raw.title)
  const visits = optionalU64(raw.visits)
  const lastVisit = optionalU64(raw.lastVisit)
  if (title === null || visits === null || lastVisit === null) return null
  return { url: raw.url, title, visits, lastVisit }
}

function absorbVisit(map: Map<string, SyncVisit>, entry: SyncVisit): void {
  const existing = map.get(entry.url)
  if (!existing) {
    map.set(entry.url, { ...entry })
    return
  }
  const newer =
    entry.lastVisit !== existing.lastVisit
      ? entry.lastVisit > existing.lastVisit
      : compareBytes(entry.title, existing.title) > 0
  existing.visits = Math.max(existing.visits, entry.visits)
  if (newer) {
    existing.lastVisit = entry.lastVisit
    existing.title = entry.title
  }
}

function sortVisits(entries: SyncVisit[]): void {
  entries.sort((a, b) => b.lastVisit - a.lastVisit || compareBytes(a.url, b.url))
}

/** Keep the most recent visits that fit. */
export function fitHistory(doc: HistoryDoc): void {
  while (byteLength(doc) > MAX_DOC_BYTES) {
    if (doc.entries.pop() === undefined) break
  }
}

export function normalizeHistory(value: unknown, week: number): HistoryDoc {
  const clearedBefore = isRecord(value) && isU64(value.clearedBefore) ? value.clearedBefore : 0
  const raw = isRecord(value) && Array.isArray(value.entries) ? value.entries : []
  const byUrl = new Map<string, SyncVisit>()
  for (const item of raw) {
    const entry = parseVisit(item)
    if (!entry || !isSyncableUrl(entry.url) || entry.lastVisit <= clearedBefore) continue
    entry.url = entry.url.trim()
    entry.title = clip(entry.title, MAX_TITLE) || entry.url
    entry.visits = Math.max(entry.visits, 1)
    absorbVisit(byUrl, entry)
  }
  const doc: HistoryDoc = {
    v: SYNC_VERSION,
    week,
    clearedBefore,
    entries: [...byUrl.values()]
  }
  sortVisits(doc.entries)
  fitHistory(doc)
  return doc
}

export function mergeHistory(local: HistoryDoc, remote: HistoryDoc): HistoryDoc {
  const clearedBefore = Math.max(local.clearedBefore, remote.clearedBefore)
  const byUrl = new Map<string, SyncVisit>()
  for (const entry of [...local.entries, ...remote.entries]) {
    if (entry.lastVisit <= clearedBefore) continue
    absorbVisit(byUrl, entry)
  }
  const doc: HistoryDoc = {
    v: SYNC_VERSION,
    week: Math.max(local.week, remote.week),
    clearedBefore,
    entries: [...byUrl.values()]
  }
  sortVisits(doc.entries)
  fitHistory(doc)
  return doc
}

/**
 * Split a flat history into the per-week documents that leave the device. Weeks older
 * than the window are not synced; every week in the window gets a document once history
 * has been cleared, so the watermark reaches weeks that have no entries left.
 */
export function historyWeeks(
  entries: SyncVisit[],
  clearedBefore: number,
  now: number
): HistoryDoc[] {
  const start = historyWindowStart(now)
  const end = weekOf(now)
  const weeks = new Map<number, HistoryDoc>()
  const docFor = (week: number): HistoryDoc => {
    let doc = weeks.get(week)
    if (!doc) {
      doc = emptyHistory(week)
      doc.clearedBefore = clearedBefore
      weeks.set(week, doc)
    }
    return doc
  }
  if (clearedBefore > 0) for (let week = start; week <= end; week += 1) docFor(week)
  for (const entry of entries) {
    const week = weekOf(entry.lastVisit)
    if (week < start || week > end || entry.lastVisit <= clearedBefore) continue
    docFor(week).entries.push({ ...entry })
  }
  const out: HistoryDoc[] = []
  for (const week of [...weeks.keys()].sort((a, b) => a - b)) {
    const doc = weeks.get(week)
    if (!doc) continue
    const byUrl = new Map<string, SyncVisit>()
    for (const entry of doc.entries) absorbVisit(byUrl, entry)
    doc.entries = [...byUrl.values()]
    sortVisits(doc.entries)
    fitHistory(doc)
    out.push(doc)
  }
  return out
}

// ───────────────────────────── Tabs ─────────────────────────────

export function normalizeTabs(value: unknown): TabsDoc | null {
  if (!isRecord(value) || value.v !== SYNC_VERSION || !isRecord(value.device)) return null
  const device = value.device
  if (!isDeviceId(device.id)) return null
  const name = optionalString(device.name)
  const platform = optionalString(device.platform)
  const updatedAt = optionalU64(value.updatedAt)
  if (name === null || platform === null || updatedAt === null) return null
  if (value.tabs !== undefined && !Array.isArray(value.tabs)) return null
  if (value.removed !== undefined && typeof value.removed !== 'boolean') return null

  const tabs: SyncTab[] = []
  for (const raw of (value.tabs as unknown[] | undefined) ?? []) {
    if (!isRecord(raw) || typeof raw.url !== 'string') continue
    const title = optionalString(raw.title)
    const lastActive = optionalU64(raw.lastActive)
    if (title === null || lastActive === null || !isSyncableUrl(raw.url)) continue
    const url = raw.url.trim()
    tabs.push({ url, title: clip(title, MAX_TITLE) || url, lastActive })
  }
  tabs.length = Math.min(tabs.length, MAX_TABS)
  const doc: TabsDoc = {
    v: SYNC_VERSION,
    device: { id: device.id, name: clip(name, 80), platform: clip(platform, 20) },
    updatedAt,
    tabs,
    ...(value.removed === true ? { removed: true as const } : {})
  }
  while (byteLength(doc) > MAX_DOC_BYTES) {
    if (doc.tabs.pop() === undefined) break
  }
  return doc
}

// ───────────────────────────── Relay filter ─────────────────────────────

/** One query that finds every sync document of an identity. */
export function syncFilter(pubkey: string): {
  kinds: number[]
  authors: string[]
  '#t': string[]
  limit: number
} {
  return { kinds: [SYNC_KIND], authors: [pubkey], '#t': [SYNC_TAG], limit: 200 }
}
