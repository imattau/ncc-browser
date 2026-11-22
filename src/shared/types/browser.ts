/**
 * The chrome's view of a browser session: tabs, navigation state, downloads, history,
 * bookmarks, overlays and omnibox suggestions.
 */

import type { HttpsMode, PageMode, TabKind } from './base'
import type { SecurityInfo } from './ncc'
import type { TorState } from './tor'

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
  'passkey-confirmation',
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
