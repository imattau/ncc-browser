/**
 * Shared types and constants. This module is imported by both the main process and
 * the renderer, so it must not depend on Node or Electron APIs.
 */

import type { SearchEngineId } from './search'

export const DEFAULT_SERVICE = 'addr'

/** Content isolation for a tab. */
export type TabKind = 'normal' | 'private' | 'tor'

export type EndpointFamily = 'onion' | 'ipv6' | 'ipv4' | 'unknown'

/** How the transport to the resolved endpoint is protected. */
export type TransportSecurity = 'pinned-tls' | 'tls' | 'plaintext' | 'nsite' | 'unknown'

/** Automatic uses the bundled Tor, then a local SOCKS proxy. Local uses the configured one. */
export type TorMode = 'auto' | 'local'

/** HTTPS policy for clearnet navigation and published NCC endpoints. */
export type HttpsMode = 'off' | 'prefer' | 'only'

export type ProtectionLevel = 'off' | 'standard' | 'strict'

export interface ProtectionConfig {
  level: ProtectionLevel
  blockScripts: boolean
  /** Site origins the user has explicitly exempted from content filtering. */
  siteExceptions: string[]
}

export const DEFAULT_PROTECTION: ProtectionConfig = {
  level: 'standard',
  blockScripts: false,
  siteExceptions: []
}

export function normalizeProtection(input: unknown): ProtectionConfig {
  const value = input && typeof input === 'object' ? (input as Partial<ProtectionConfig>) : {}
  return {
    level: value.level === 'off' || value.level === 'strict' ? value.level : 'standard',
    blockScripts: value.blockScripts === true,
    siteExceptions: Array.isArray(value.siteExceptions)
      ? [...new Set(value.siteExceptions.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))].slice(-200)
      : []
  }
}

export const DEFAULT_HTTPS_MODE: HttpsMode = 'prefer'

export const DEFAULT_TOR_SOCKS = 'socks5://127.0.0.1:9050'

/** How the chrome resolves light and dark: follow the OS, or pin one. */
export type ThemePreference = 'system' | 'light' | 'dark'

export type TextSizePreference = 'small' | 'default' | 'large' | 'xlarge'

export type AccentPreference = 'blue' | 'violet' | 'green' | 'amber'

export type DensityPreference = 'comfortable' | 'compact'

export interface AppearanceConfig {
  theme: ThemePreference
  textSize: TextSizePreference
  accent: AccentPreference
  density: DensityPreference
  reduceMotion: boolean
}

/** Dark by default, keeping the look earlier versions shipped with. */
export const DEFAULT_APPEARANCE: AppearanceConfig = {
  theme: 'dark',
  textSize: 'default',
  accent: 'blue',
  density: 'comfortable',
  reduceMotion: false
}

/** Multiplier applied to every `text-ui-*` utility. */
export const TEXT_SIZE_SCALES: Record<TextSizePreference, number> = {
  small: 0.9,
  default: 1,
  large: 1.1,
  xlarge: 1.2
}

export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark']
export const TEXT_SIZE_PREFERENCES: TextSizePreference[] = ['small', 'default', 'large', 'xlarge']
export const ACCENT_PREFERENCES: AccentPreference[] = ['blue', 'violet', 'green', 'amber']
export const DENSITY_PREFERENCES: DensityPreference[] = ['comfortable', 'compact']

/* ------------------------------------------------------------------ */
/*  Password manager                                                  */
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
  createdAt: number
  updatedAt: number
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

/* ------------------------------------------------------------------ */
/*  Payment cards                                                     */
/* ------------------------------------------------------------------ */

export interface PaymentCard {
  id: string
  name: string
  number: string
  /** Optional security code; only populated when the user opts in. */
  cvc?: string
  expMonth: string
  expYear: string
  nickname: string
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

export interface PaymentCardDraft {
  id?: string
  name: string
  number: string
  cvc?: string
  expMonth: string
  expYear: string
  nickname: string
}

export interface PaymentCardSummary {
  id: string
  name: string
  last4: string
  network: string
  expMonth: string
  expYear: string
  nickname: string
}

export interface PaymentCardSettingsStatus {
  unlocked: boolean
  authAvailable: boolean
  nostrAuthAvailable: boolean
  allowNostrAuth: boolean
  defaultNostrAuth: boolean
  enabled: boolean
  offerSave: boolean
  saveSecurityCodes: boolean
  cards: PaymentCardSummary[]
}

export interface PaymentCardSaveRequest {
  id: string
  mode: 'create' | 'update'
  name: string
  last4: string
  network: string
  expMonth: string
  expYear: string
  includesSecurityCode?: boolean
}

export interface PaymentCardSaveResult {
  ok: boolean
  error?: string
  pending?: boolean
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

/**
 * Tolerant normalisation for anything that may have come from an older config
 * file or from the renderer. Unknown values fall back to the defaults.
 */
export function normalizeAppearance(input: unknown): AppearanceConfig {
  const value = input && typeof input === 'object' ? (input as Partial<AppearanceConfig>) : {}
  return {
    theme: THEME_PREFERENCES.includes(value.theme as ThemePreference)
      ? (value.theme as ThemePreference)
      : DEFAULT_APPEARANCE.theme,
    textSize: TEXT_SIZE_PREFERENCES.includes(value.textSize as TextSizePreference)
      ? (value.textSize as TextSizePreference)
      : DEFAULT_APPEARANCE.textSize,
    accent: ACCENT_PREFERENCES.includes(value.accent as AccentPreference)
      ? (value.accent as AccentPreference)
      : DEFAULT_APPEARANCE.accent,
    density: DENSITY_PREFERENCES.includes(value.density as DensityPreference)
      ? (value.density as DensityPreference)
      : DEFAULT_APPEARANCE.density,
    reduceMotion:
      typeof value.reduceMotion === 'boolean'
        ? value.reduceMotion
        : DEFAULT_APPEARANCE.reduceMotion
  }
}

export interface TorState {
  /** Global preference: use onion endpoints automatically when a locator has one. */
  preferTor: boolean
  /** The current record publishes at least one usable .onion endpoint. */
  onionAvailable: boolean
  /** The current document was fetched from an onion endpoint. */
  active: boolean
  /** The active tab is a full Tor tab (all traffic is proxied). */
  tabTor: boolean
}

export type TorRuntimeKind = 'bundled' | 'local'

export interface TorStatus {
  ready: boolean
  starting: boolean
  proxy: string | null
  kind: TorRuntimeKind | null
  error: string | null
  mode: TorMode
  configured: string
}

/**
 * Metadata for a relay entry that was resolved from an NCC-05 service locator
 * (`ncc://<npub>/<service>`). Kept so the entry can be re-resolved before it goes
 * stale, and so the locator's `k` can be enforced as a TLS pin.
 */
export interface RelayLocatorRef {
  /** Identity exactly as the user entered it (npub or hex). */
  identity: string
  /** Hex pubkey of the identity that published the locator. */
  pubkey: string
  service: string
  /** The `d` tag that matched. */
  dTag: string
  /** Unix seconds after which the locator must be re-resolved. */
  expiresAt: number
  /** Unix seconds after which the NCC-02 service record must be revalidated, when set. */
  serviceExpiresAt?: number
  /** SPKI fingerprint from the endpoint, enforced on `wss:` connections. */
  k: string | null
}

export interface RelayEntry {
  /** Resolved `ws(s)://` endpoint. */
  url: string
  /** Present when the entry came from an NCC-05 locator rather than a fixed URL. */
  locator?: RelayLocatorRef
  /** The last re-resolution failed; the entry keeps working at its previous address. */
  stale?: boolean
}

export type RelayLocatorErrorCode =
  | ResolveErrorCode
  | 'onion-requires-tor'
  | 'insecure-endpoint'

export interface RelayLocatorFailure {
  ok: false
  code: RelayLocatorErrorCode
  error: string
}

export interface RelayLocatorSuccess {
  ok: true
  entry: RelayEntry
}

export type RelayLocatorOutcome = RelayLocatorSuccess | RelayLocatorFailure

export interface ResolvedEndpoint {
  /** Absolute http(s) or ws(s) URL, normalised so it can be handed straight to fetch. */
  url: string
  protocol: string
  priority: number
  family: EndpointFamily
  /** SPKI fingerprint from the locator (`k`), if the publisher supplied one. */
  k: string | null
  /** Which document supplied the fingerprint that is actually pinned. */
  kSource?: 'ncc-02' | 'ncc-05' | null
}

export interface ServiceAnchor {
  eventId: string
  dTag: string
  /** Fetchable http(s) `u` endpoint, when the record publishes one. */
  endpoint: string | null
  /** The raw `u` value, including non-web schemes such as `wss://` or `onion://`. */
  rawEndpoint: string | null
  k: string | null
  /** Unix seconds; 0 means the record carries no `exp` tag. */
  expiresAt: number
  updatedAt: number
}

export type AnchorStatus =
  | 'anchored'
  | 'unanchored'
  | 'expired'
  | 'invalid'
  | 'required-missing'

export type AnchorKeyMatch =
  | 'match'
  | 'mismatch'
  | 'anchor-only'
  | 'locator-only'
  | 'none'

export interface AnchorInfo {
  status: AnchorStatus
  record: ServiceAnchor | null
  /** True when the page is being served from the NCC-02 `u` fallback. */
  fallback: boolean
  /** How the NCC-02 and NCC-05 transport fingerprints relate. */
  kMatch: AnchorKeyMatch
  /** Whether the user requires NCC-02 anchoring. */
  required: boolean
}

export interface ResolvedService {
  /** npub (or hex) exactly as it was addressed. */
  pubkey: string
  hexPubkey: string
  service: string
  /** The `d` tag that actually matched. */
  dTag: string
  dTagSource: 'exact' | 'locator-suffix' | 'default'
  endpoints: ResolvedEndpoint[]
  /** Unix seconds. */
  expiresAt: number
  updatedAt: number
  eventId: string
  encrypted: boolean
  /** Served from the cached copy; relays have not confirmed it yet. */
  stale?: boolean
  /** NCC-02 trust anchor, when one was found. */
  anchor?: AnchorInfo
}

export type ResolveErrorCode =
  | 'invalid-address'
  | 'no-record'
  | 'expired'
  | 'undecryptable'
  | 'invalid-payload'
  | 'no-endpoint'
  | 'relay-error'
  | 'timeout'
  | 'no-anchor'
  | 'anchor-expired'
  | 'anchor-invalid'
  | 'anchor-k-mismatch'

export interface ResolveFailure {
  ok: false
  code: ResolveErrorCode
  message: string
  detail?: string
}

export interface ResolveSuccess {
  ok: true
  record: ResolvedService
}

export type ResolveOutcome = ResolveSuccess | ResolveFailure

export interface SecurityInfo {
  transport: TransportSecurity
  /** Host of the endpoint that served the current document, never the full URL. */
  host: string
  pinned: boolean
  /** True when the document was fetched from an onion endpoint through Tor. */
  viaTor: boolean
  /** True when the selected endpoint is an onion endpoint (regardless of transport). */
  onion: boolean
  /** NCC-02 trust anchor attached to the locator that served this page. */
  anchor: AnchorInfo | null
  /** The NCC-05 record that produced the endpoint, for the site panel. */
  locator: LocatorInfo | null
  /** NIP-5A manifest that produced this page, when the page came from nsite://. */
  manifest?: NsiteInfo | null
}

/** What the site panel shows for a page served from a NIP-5A manifest. */
export interface NsiteInfo {
  /** Named site id, or null for the author's root site. */
  site: string | null
  title: string | null
  description: string | null
  source: string | null
  eventId: string
  updatedAt: number
  aggregate: string | null
  servers: string[]
  files: number
}

/** How old the record behind the current page is, and where it came from. */
export interface LocatorInfo {
  eventId: string
  /** The `d` tag that matched, which may differ from the requested service. */
  dTag: string
  /** Unix seconds when the publisher last refreshed the payload. */
  updatedAt: number
  /** Unix seconds after which the record may not be used. */
  expiresAt: number
  /** Served from the cached copy; relays have not confirmed it yet. */
  stale: boolean
  /** Synthesised from the NCC-02 `u` endpoint because no NCC-05 record was usable. */
  fallback: boolean
}

export type PageMode = 'blank' | 'ncc' | 'nsite' | 'web' | 'error'

export interface TabSummary {
  id: string
  kind: TabKind
  title: string
  url: string
  loading: boolean
  /** Data URL for the page icon, fetched in main and never linked to the remote origin. */
  favicon: string | null
  audible: boolean
  muted: boolean
}

export type DownloadState = 'started' | 'completed' | 'failed' | 'cancelled'

export interface DownloadNotice {
  id: string
  filename: string
  state: DownloadState
  path?: string
  /** Bytes written so far. Both byte counts are 0 when the server sends no length. */
  receivedBytes: number
  totalBytes: number
  /** Epoch milliseconds. */
  startedAt: number
  /** Download was started from a private or Tor tab. */
  private?: boolean
}

export interface HistoryEntry {
  index: number
  title: string
  url: string
}

export interface TabHistory {
  entries: HistoryEntry[]
  activeIndex: number
}

export interface Bookmark {
  /** The URL doubles as the identity of a bookmark. */
  url: string
  title: string
  /** Epoch milliseconds. */
  createdAt: number
  /** Epoch milliseconds of the last edit; older files only have `createdAt`. */
  updatedAt?: number
}

/** Reasons the chrome needs the whole window surface, hiding content views. */
export const OVERLAY_REASONS = [
  'menu',
  'settings',
  'identity-chooser',
  'downloads',
  'history',
  'tabs',
  'site-info',
  'insecure',
  'passwords',
  'password-save',
  'payment-card-save',
  'wallet',
  'share-nostr'
] as const

export type OverlayReason = (typeof OVERLAY_REASONS)[number]

export interface SecurityBanner {
  tone: 'warn' | 'info'
  title: string
  detail: string
}

export interface InsecurePrompt {
  url: string
  host: string
  ephemeral: boolean
  tor: boolean
  mode: HttpsMode
}

export interface NavState {
  mode: PageMode
  /** Canonical address shown in the address bar. */
  displayUrl: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  security: SecurityInfo | null
  failure: { code: string; message: string } | null
  tor: TorState
  tabKind: TabKind
  banner: SecurityBanner | null
  insecurePrompt: InsecurePrompt | null
  tabs: TabSummary[]
  activeTabId: string | null
  windowMaximized: boolean
}

export interface AppConfig {
  /** Resolution relays; an entry may be identity-resolved rather than a fixed URL. */
  relays: RelayEntry[]
  /** Follow NIP-65 relay hints published by the target identity. */
  gossip: boolean
  /** Refuse services that have no fresh NCC-02 service record (kind 30059). */
  anchorRequired: boolean
  /** Automatically use an onion endpoint when the locator publishes one. */
  preferTor: boolean
  /** Use per-session generated NIP-07 keys in private and Tor tabs. */
  ephemeralSigner: boolean
  /** Automatic prefers the bundled Tor, then a local proxy. */
  torMode: TorMode
  /** Explicit SOCKS proxy used in local mode or when NCC_TOR_SOCKS is unset. */
  torSocks: string
  /** How aggressively to upgrade or require HTTPS. */
  httpsMode: HttpsMode
  /** Tracker/ad filtering, independent of the HTTPS policy. */
  protection?: ProtectionConfig
  /** Show a blocking interstitial before loading HTTP pages. */
  warnInsecure: boolean
  /** Origins/keys the user has allowed over HTTP. */
  httpExceptions: string[]
  /** Search engine used when the address bar input is not a URL. */
  searchEngine: SearchEngineId
  /** SearXNG instance URL, or a full `%s` template for the custom engine. */
  searchEngineCustom: string
  /** Use an engine's onion endpoint inside full Tor tabs. */
  useOnionSearch: boolean
  /** Enable the bundled, relay-local nccsearch page. */
  nccSearchEnabled?: boolean
  /** Theme, text size, density, accent and motion preferences. */
  appearance: AppearanceConfig
  /** Password manager lock, save, relay and never-save preferences. */
  passwords: PasswordConfig
}

export type OmniboxSuggestionKind = 'action' | 'bookmark' | 'history' | 'tab' | 'service'

export type OmniboxSuggestionIcon = 'search' | 'web' | 'ncc' | 'star' | 'clock' | 'tab'

export interface OmniboxSuggestion {
  id: string
  kind: OmniboxSuggestionKind
  icon: OmniboxSuggestionIcon
  title: string
  detail: string
  /** The URL to open. Empty when a suggestion only switches tabs. */
  url: string
  /** Tab suggestions switch to this tab instead of navigating. */
  tabId?: string
}

export type IdentitySource = 'none' | 'env' | 'file' | 'session'

export type IdentityMode = 'none' | 'local' | 'nip46'

export interface IdentityStatus {
  configured: boolean
  mode: IdentityMode
  npub?: string
  hexPubkey?: string
  source: IdentitySource
  /** True when the key (or NIP-46 session) is encrypted at rest with the OS keychain. */
  persisted: boolean
  /** False when the OS offers no secure storage; the key then lives for this session. */
  encryptionAvailable: boolean
  /** NIP-46 relays, when mode is `nip46`. */
  relays?: string[]
  /** NIP-46 connection acknowledged by the remote signer. */
  connected?: boolean
}

export interface IdentityProfile {
  id: string
  mode: 'local' | 'nip46'
  npub?: string
  hexPubkey: string
  active: boolean
  isDefault: boolean
  persisted: boolean
  connected?: boolean
}

export interface IdentityList {
  identities: IdentityProfile[]
  activeId: string | null
  defaultId: string | null
}

export interface SignerPermission {
  /** `ncc://<npub>` or a web origin. */
  origin: string
  label: string
  trusted: boolean
  /** Epoch milliseconds. */
  createdAt: number
  lastUsedAt: number
}

/** Trust state for the page the site panel is showing. */
export interface SignerOriginState {
  origin: string
  label: string
  trusted: boolean
}

/** Build and runtime metadata shown in Settings → About. */
export interface AppInfo {
  version: string
  electron: string
  chromium: string
  platform: string
  arch: string
}

export interface SignerRequest {
  id: string
  method: string
  /** Short imperative phrase, e.g. "sign a kind 1 event". */
  action: string
  /** `ncc://<npub>/<service>` or a web origin. */
  service: string
  origin: string
  identity: string | null
  mode: IdentityMode
  /** Present for `signEvent`. */
  event?: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }
  /** Extra context for encryption/decryption requests. */
  note?: string
  rememberable: boolean
  /** Private or Tor tab: permissions last for this session only. */
  ephemeral?: boolean
  /** Tor tab: remote-signer relay traffic is not routed through Tor. */
  torTab?: boolean
  /** Label for the remember control, e.g. "Always allow" or "Remember for this session". */
  rememberLabel?: string
  /** Additional browser-owned approval flows shown in the same trusted prompt. */
  kind?: 'automation' | 'payment-card-auth'
}

export interface SignerDecision {
  allow: boolean
  remember: boolean
}

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net'
]

/** Human-readable one-liners used by the error page and the renderer. */
export const ERROR_COPY: Record<string, { title: string; hint: string }> = {
  'invalid-address': {
    title: 'Not an NCC address',
    hint: 'An NCC address looks like ncc://npub1…/service. The npub is the trust anchor, so it cannot be omitted.'
  },
  'no-record': {
    title: 'No locator published',
    hint: 'The npub is valid, but no fresh NCC-05 (kind 30058) record was found on the configured relays. Check that the publisher is online and pointed at these relays.'
  },
  'no-manifest': {
    title: 'No site published',
    hint: 'No NIP-5A manifest was found for this npub on the configured relays. For a named site, check the site id; for a root site, look for a kind 15128 event.'
  },
  'manifest-invalid': {
    title: 'Malformed site manifest',
    hint: 'The manifest was signed by the right key, but it has no usable path entries or contains an invalid hash.'
  },
  'no-file': {
    title: 'File not in this site',
    hint: 'The manifest does not list this path, and no /404.html was published. Static sites only serve the files in their manifest.'
  },
  'blob-unavailable': {
    title: 'File unavailable',
    hint: 'The manifest lists this file, but no Blossom server returned it. The author needs to republish the blob, or add a server hint.'
  },
  'hash-mismatch': {
    title: 'File failed verification',
    hint: 'A Blossom server returned bytes that do not match the sha256 in the signed manifest. The file was discarded.'
  },
  'too-large': {
    title: 'File is too large',
    hint: 'The file exceeds the 25 MB limit for hash-verified downloads. Large media is not supported yet.'
  },
  expired: {
    title: 'Locator expired',
    hint: 'A record exists but its TTL has passed. NCC-05 forbids using expired locators, so the publisher needs to refresh it.'
  },
  undecryptable: {
    title: 'Locator is private',
    hint: 'This record is encrypted and you are not one of its recipients. Ask the publisher to add your npub, or use a public locator.'
  },
  'invalid-payload': {
    title: 'Malformed locator',
    hint: 'The record was signed correctly but its payload is not valid NCC-05 JSON, or contains no usable endpoints.'
  },
  'no-endpoint': {
    title: 'No usable endpoint',
    hint: 'The locator lists endpoints, but none can be used by this browser (for example only ws:// transports).'
  },
  'onion-only': {
    title: 'Onion endpoint only',
    hint: 'This locator publishes only an onion endpoint. Turn on "Prefer Tor connections" in settings, or use the onion button in the address bar to open it in a Tor tab.'
  },
  'tor-unavailable': {
    title: 'Tor is not available',
    hint: 'NCC found an onion endpoint, but the browser could not start or reach Tor. Check the Tor proxy in settings, or make sure the bundled Tor binary is installed.'
  },
  'tor-clearnet-redirect': {
    title: 'Tor blocked a clearnet redirect',
    hint: 'The onion service tried to redirect this page to the clearnet. The redirect was blocked so the request could not reveal your IP. Load the page without Tor if you trust the destination.'
  },
  'tor-blocked-resource': {
    title: 'Tor blocked a clearnet resource',
    hint: 'A page loaded over Tor requested an NCC resource whose locator has no onion endpoint. The request was blocked so it could not reveal your IP.'
  },
  'insecure-blocked': {
    title: 'Insecure connection blocked',
    hint: 'HTTPS-only is enabled and this resource would use plaintext HTTP. Load the page and choose to allow HTTP if you trust the destination.'
  },
  'relay-error': {
    title: 'Relay query failed',
    hint: 'The configured relays could not be reached. Check your connection and relay list.'
  },
  timeout: {
    title: 'Resolution timed out',
    hint: 'The relays did not answer in time. This is often a slow or unreachable relay.'
  },
  'no-anchor': {
    title: 'No NCC-02 service record',
    hint: 'Anchored mode is on, so this service must publish a fresh kind 30059 service record. Publish one from the NCC publisher, or turn off "Require NCC-02 service records" in settings.'
  },
  'anchor-expired': {
    title: 'NCC-02 service record expired',
    hint: 'The service record exists but its exp tag has passed. Anchored mode fails closed until the publisher refreshes it.'
  },
  'anchor-invalid': {
    title: 'NCC-02 service record is invalid',
    hint: 'The kind 30059 event is missing a valid d tag, has an invalid exp tag, or failed signature verification.'
  },
  'anchor-k-mismatch': {
    title: 'Transport key conflicts with NCC-02',
    hint: 'The NCC-02 service record and the NCC-05 locator advertise different transport fingerprints for the same endpoint. The browser refused the endpoint.'
  },
  'endpoint-unreachable': {
    title: 'Endpoint unreachable',
    hint: 'The locator is valid, but the service did not accept a connection. The publisher may be offline or behind a firewall.'
  },
  'k-mismatch': {
    title: 'Transport identity mismatch',
    hint: 'The TLS certificate presented by the endpoint does not match the fingerprint signed into the locator. The connection was refused.'
  },
  'certificate-expired': {
    title: 'Transport certificate expired',
    hint: 'The endpoint presented a certificate that is no longer valid. The locator pins a transport identity; an expired certificate cannot satisfy it.'
  }
}
