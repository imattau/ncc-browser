/**
 * User-facing configuration: appearance, content protection, HTTPS and Tor policy, and
 * the `AppConfig` object persisted by the main process.
 */

import type { SearchEngineId } from '../search'
import type { PasswordConfig } from '../passwords'
import type { HttpsMode, TorMode } from './base'
import type { RelayEntry } from './ncc'

export const DEFAULT_HTTPS_MODE: HttpsMode = 'prefer'

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net'
]

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

/** How the chrome resolves light and dark: follow the OS, or pin one. */
export type ThemePreference = 'system' | 'light' | 'dark'

export type TextSizePreference = 'small' | 'default' | 'large' | 'xlarge'

export type AccentPreference = 'blue' | 'violet' | 'green' | 'amber'

export type DensityPreference = 'comfortable' | 'compact'

/** Desktop only: tabs in a strip along the top, or in a sidebar with the bookmarks. */
export type TabLayout = 'horizontal' | 'vertical'

export interface AppearanceConfig {
  theme: ThemePreference
  textSize: TextSizePreference
  accent: AccentPreference
  density: DensityPreference
  reduceMotion: boolean
  tabLayout: TabLayout
  /** The bookmarks toolbar under the address bar; only with tabs along the top. */
  bookmarksBar: boolean
  /** The sidebar shrunk to a strip of icons. */
  sidebarCollapsed: boolean
  /** The bookmarks list in the expanded sidebar. */
  sidebarBookmarks: boolean
}

/** Dark by default, keeping the look earlier versions shipped with. */
export const DEFAULT_APPEARANCE: AppearanceConfig = {
  theme: 'dark',
  textSize: 'default',
  accent: 'blue',
  density: 'comfortable',
  reduceMotion: false,
  tabLayout: 'horizontal',
  bookmarksBar: false,
  sidebarCollapsed: false,
  sidebarBookmarks: true
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
        : DEFAULT_APPEARANCE.reduceMotion,
    tabLayout: value.tabLayout === 'vertical' ? 'vertical' : DEFAULT_APPEARANCE.tabLayout,
    bookmarksBar: flag(value.bookmarksBar, DEFAULT_APPEARANCE.bookmarksBar),
    sidebarCollapsed: flag(value.sidebarCollapsed, DEFAULT_APPEARANCE.sidebarCollapsed),
    sidebarBookmarks: flag(value.sidebarBookmarks, DEFAULT_APPEARANCE.sidebarBookmarks)
  }
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export type ExternalAddressCheck = 'ask' | 'always' | 'never'

export interface AppConfig {
  /** Resolution relays; an entry may be identity-resolved rather than a fixed URL. */
  relays: RelayEntry[]
  /** Follow NIP-65 relay hints published by the target identity. */
  gossip: boolean
  /** Refuse services that have no fresh NCC-02 service record (kind 30059). */
  anchorRequired: boolean
  /**
   * When endpoint discovery may contact a public address service to confirm the
   * internet egress. `ask` shows a button; `always` runs it automatically.
   */
  externalAddressChecks?: ExternalAddressCheck
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

/** Build and runtime metadata shown in Settings → About. */
export interface AppInfo {
  version: string
  electron: string
  chromium: string
  platform: string
  arch: string
}
