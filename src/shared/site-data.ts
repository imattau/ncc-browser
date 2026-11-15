/**
 * Site-data model shared by the main process, preload and tests.
 *
 * Chromium keys cookies and DOM storage by origin. NCC pages are served from
 * `ncc://<npub>/…`, so one identity shares a single storage origin across all of its
 * services. Trust decisions (HTTP exceptions, NIP-07 permissions and password
 * never-save entries) are keyed per service, so they keep their own key.
 */

import type { TabKind } from './types'
import { pageOriginFromUrl } from './passwords'

export interface SiteDataInfo {
  /** False for blank, error-without-identity and non-content pages. */
  supported: boolean
  /** Origin used for cookies, localStorage, IndexedDB, CacheStorage and SWs. */
  origin: string
  /** Origin plus service used by HTTP exceptions, signer trust and passwords. */
  trustKey: string
  /** Clean address for display. */
  label: string
  /** Address currently loaded in the tab. */
  url: string
  tabKind: TabKind
  /** Private and Tor sessions are wiped when their last tab closes. */
  ephemeral: boolean
  /** `null` when the cookies could not be read. */
  cookies: number | null
  /**
   * Host whose cookie jar serves this page. Web pages use their own host; NCC pages
   * use the endpoint host, because the protocol handler fetches them with the
   * content session's cookie jar.
   */
  cookieHost: string | null
  /** True when `cookieHost` is a shared NCC endpoint, not the page's own origin. */
  endpointCookies: boolean
  hasHttpException: boolean
  signerTrusted: boolean
  passwordNeverSave: boolean
}

export interface SiteDataClearOptions {
  /** Also drop the HTTP exception, NIP-07 trust and never-save entry. */
  forgetTrust: boolean
}

export interface SiteDataClearResult {
  ok: boolean
  origin: string
  cookiesRemoved: number
  storageCleared: boolean
  trustCleared: boolean
  error?: string
}

export interface CacheInfo {
  normal: number
  private: number
  tor: number
  extensions: number
  /** Resolved NCC locators kept on disk; counted as entries, not bytes. */
  locators: number
  /** Total of the HTTP/network caches, excluding locators. */
  total: number
}

export interface SiteIdentity {
  /** Storage origin: `ncc://<npub>` or the web origin. */
  origin: string
  /** Trust key: `ncc://<npub>/<service>` or the web origin. */
  trustKey: string
  /** Clean address for the panel, e.g. `ncc://npub1…/web`. */
  label: string
  host: string
  service: string | null
}

export const UNSUPPORTED_SITE: SiteDataInfo = {
  supported: false,
  origin: '',
  trustKey: '',
  label: '',
  url: '',
  tabKind: 'normal',
  ephemeral: false,
  cookies: null,
  cookieHost: null,
  endpointCookies: false,
  hasHttpException: false,
  signerTrusted: false,
  passwordNeverSave: false
}

export function siteIdentityForUrl(raw: string): SiteIdentity | null {
  const page = pageOriginFromUrl(raw)
  if (!page) return null
  if (page.scheme === 'ncc') {
    return {
      origin: `ncc://${page.host}`,
      trustKey: page.origin,
      label: page.origin,
      host: page.host,
      service: page.service ?? null
    }
  }
  return {
    origin: page.origin,
    trustKey: page.origin,
    label: page.origin,
    host: page.host,
    service: null
  }
}

/** Cookies and DOM storage share an origin; compare without path or port surprises. */
export function isSameSite(candidate: string, origin: string): boolean {
  const identity = siteIdentityForUrl(candidate)
  return identity != null && identity.origin === origin
}

export function emptyCacheInfo(): CacheInfo {
  return { normal: 0, private: 0, tor: 0, extensions: 0, locators: 0, total: 0 }
}

export function totalCacheBytes(info: Omit<CacheInfo, 'total' | 'locators'>): number {
  return info.normal + info.private + info.tor + info.extensions
}

/** Compact byte formatting for the settings card. */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}
