/**
 * Clearing cookies and site data for the active tab, plus the global network cache.
 *
 * Everything is derived from the active tab rather than a renderer-supplied URL. The
 * session is the tab's own partition, so normal, private and Tor data stay separate.
 * `clearStorageData({ origin })` is the primary path; the live tab gets a direct
 * localStorage/IndexedDB/CacheStorage sweep as a guarantee for the custom `ncc://`
 * scheme, whose origin Chromium may not match from the browsing-data API alone.
 */

import type { Cookie, Session } from 'electron'
import {
  isSameSite,
  siteIdentityForUrl,
  totalCacheBytes,
  UNSUPPORTED_SITE,
  type CacheInfo,
  type SiteDataClearOptions,
  type SiteDataClearResult,
  type SiteDataInfo
} from '@shared/site-data'
import type { TabKind } from '@shared/types'
import type { ConfigStore } from './config'
import type { BrowserShell } from './shell'
import type { PermissionStore } from './signer/permissions'
import { permissionOrigin, type SitePermissionStore } from './site-permissions'

export interface SiteDataDeps {
  host: BrowserShell
  config: ConfigStore
  permissions: PermissionStore
  sitePermissions: SitePermissionStore
  sessions: Record<TabKind, Session>
  extensionSession: Session
  /** Resolved NCC-05 records that survive restarts. */
  locators: {
    count(): number
    clear(): void
    invalidate(kind: TabKind, pubkey: string, service: string | null): void
  }
}

const STORAGE_TYPES = [
  'cookies',
  'filesystem',
  'indexdb',
  'localstorage',
  'cachestorage',
  'serviceworkers'
] as const

/** Runs inside the page: clear DOM storage, IndexedDB and CacheStorage for the origin. */
const CLEAR_PAGE_SCRIPT = `(async () => {
  const result = { local: 0, session: 0, databases: 0, caches: 0 }
  try {
    result.local = localStorage.length
    localStorage.clear()
    result.session = sessionStorage.length
    sessionStorage.clear()
  } catch (error) {
    // Storage can be unavailable in opaque origins; cookies are still cleared.
  }
  try {
    if (indexedDB && typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases()
      for (const entry of databases) {
        if (!entry.name) continue
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(entry.name)
          request.onsuccess = request.onerror = request.onblocked = () => resolve()
        })
        result.databases += 1
      }
    }
  } catch (error) {
    // A blocked database delete must not fail the whole operation.
  }
  try {
    if (globalThis.caches) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
      result.caches = keys.length
    }
  } catch (error) {
    // Same for CacheStorage.
  }
  return result
})()`

export class SiteDataService {
  constructor(private readonly deps: SiteDataDeps) {}

  async describe(): Promise<SiteDataInfo> {
    const page = this.deps.host.activePage()
    const identity = page ? siteIdentityForUrl(page.url) : null
    if (!page || !identity) return { ...UNSUPPORTED_SITE }
    if (page.mode === 'blank') {
      return { ...UNSUPPORTED_SITE, tabKind: page.kind, label: identity.label }
    }

    const session = this.sessionFor(page.kind)
    const jar = await this.cookiesFor(session, page)
    return {
      supported: true,
      origin: identity.origin,
      trustKey: identity.trustKey,
      label: identity.label,
      url: page.url,
      tabKind: page.kind,
      ephemeral: page.kind !== 'normal',
      cookies: jar ? jar.cookies.length : null,
      cookieHost: jar?.host ?? null,
      endpointCookies: jar?.endpoint ?? false,
      hasHttpException: this.hasHttpException(identity.trustKey),
      signerTrusted: this.deps.permissions.isTrusted(identity.trustKey),
      passwordNeverSave: this.deps.config
        .get()
        .passwords.neverSave.includes(identity.trustKey),
      hasSavedSitePermissionChoices: page.kind === 'normal' && this.deps.sitePermissions.hasOrigin(
        permissionOrigin(page.url) ?? identity.origin
      )
    }
  }

  async clearActiveSite(options: SiteDataClearOptions): Promise<SiteDataClearResult> {
    const page = this.deps.host.activePage()
    const identity = page ? siteIdentityForUrl(page.url) : null
    if (!page || !identity || page.mode === 'blank') {
      return {
        ok: false,
        origin: '',
        cookiesRemoved: 0,
        storageCleared: false,
        trustCleared: false,
        sitePermissionsCleared: false,
        error: 'This page has no site data to clear'
      }
    }

    const session = this.sessionFor(page.kind)
    let storageCleared = false
    try {
      await session.clearStorageData({
        origin: identity.origin,
        storages: [...STORAGE_TYPES]
      })
      storageCleared = true
    } catch (error) {
      console.warn('[site-data] clearStorageData failed:', error)
    }

    const jar = await this.cookiesFor(session, page)
    let cookiesRemoved = 0
    for (const cookie of jar?.cookies ?? []) {
      try {
        await session.cookies.remove(cookieRemovalUrl(cookie), cookie.name)
        cookiesRemoved += 1
      } catch {
        // A cookie that vanished between get and remove is not an error.
      }
    }

    const pageCleared = await this.clearPageStorage(identity.origin)
    if (pageCleared) storageCleared = true

    let trustCleared = false
    if (options.forgetTrust) {
      trustCleared = this.forgetTrust(identity.trustKey)
    }

    const sitePermissionsCleared = options.forgetSitePermissions && page.kind === 'normal'
      ? this.deps.sitePermissions.revokeOrigin(permissionOrigin(page.url) ?? identity.origin)
      : false

    this.deps.host.reloadTab(page.tabId)
    return {
      ok: true,
      origin: identity.origin,
      cookiesRemoved,
      storageCleared,
      trustCleared,
      sitePermissionsCleared
    }
  }

  async cacheInfo(): Promise<CacheInfo> {
    const [normal, privateBytes, tor, extensions] = await Promise.all([
      this.size(this.deps.sessions.normal),
      this.size(this.deps.sessions.private),
      this.size(this.deps.sessions.tor),
      this.size(this.deps.extensionSession)
    ])
    const sizes = { normal, private: privateBytes, tor, extensions }
    return {
      ...sizes,
      locators: this.deps.locators.count(),
      total: totalCacheBytes(sizes)
    }
  }

  async clearCache(): Promise<CacheInfo> {
    await Promise.all([
      this.clearSessionCache(this.deps.sessions.normal),
      this.clearSessionCache(this.deps.sessions.private),
      this.clearSessionCache(this.deps.sessions.tor),
      this.clearSessionCache(this.deps.extensionSession)
    ])
    // The locator cache lives outside Chromium's caches, so clearing the network
    // cache alone would leave a rotated endpoint pinned. Drop both together.
    this.deps.locators.clear()
    return this.cacheInfo()
  }

  /**
   * Forget the locator behind the active page and reload it, so relays are asked
   * again even while the cached record is still unexpired.
   */
  revalidateActiveSite(): boolean {
    const page = this.deps.host.activePage()
    const identity = page ? siteIdentityForUrl(page.url) : null
    if (!page || !identity || page.mode === 'blank') return false
    // nsite manifests are invalidated by the shell's force reload; only NCC has a
    // locator cache to drop here.
    if (identity.scheme === 'ncc') {
      this.deps.locators.invalidate(page.kind, identity.host, identity.service)
    }
    this.deps.host.reloadTab(page.tabId)
    return true
  }

  private sessionFor(kind: TabKind): Session {
    return this.deps.sessions[kind]
  }

  /**
   * NCC pages do not get their own cookie jar: the protocol handler fetches each
   * document through the content session, so cookies land under the endpoint host.
   * Web pages keep their normal origin-scoped jar.
   */
  private async cookiesFor(
    session: Session,
    page: { mode: string; url: string; security: { host: string } | null }
  ): Promise<{ cookies: Cookie[]; host: string; endpoint: boolean } | null> {
    const identity = siteIdentityForUrl(page.url)
    if (!identity) return null
    if (page.mode === 'ncc') {
      const host = page.security?.host
      if (!host) return { cookies: [], host: identity.host, endpoint: true }
      try {
        return { cookies: await session.cookies.get({ domain: host }), host, endpoint: true }
      } catch {
        return null
      }
    }
    try {
      return {
        cookies: await session.cookies.get({ url: page.url }),
        host: identity.host,
        endpoint: false
      }
    } catch {
      return null
    }
  }

  private async clearPageStorage(origin: string): Promise<boolean> {
    const contents = this.deps.host.activeContents()
    if (!contents || !isSameSite(contents.getURL(), origin)) return false
    try {
      await contents.executeJavaScript(CLEAR_PAGE_SCRIPT, true)
      return true
    } catch (error) {
      console.warn('[site-data] page storage sweep failed:', error)
      return false
    }
  }

  private hasHttpException(trustKey: string): boolean {
    return this.deps.config.get().httpExceptions.includes(trustKey)
  }

  private forgetTrust(trustKey: string): boolean {
    let changed = false
    if (this.hasHttpException(trustKey)) {
      this.deps.config.removeHttpException(trustKey)
      changed = true
    }
    if (this.deps.permissions.isTrusted(trustKey)) {
      this.deps.permissions.revoke(trustKey)
      changed = true
    }
    if (this.deps.config.get().passwords.neverSave.includes(trustKey)) {
      this.deps.config.removeNeverSave(trustKey)
      changed = true
    }
    return changed
  }

  private size(session: Session): Promise<number> {
    return session.getCacheSize().catch(() => 0)
  }

  private clearSessionCache(session: Session): Promise<void> {
    return session.clearCache().catch(() => undefined)
  }
}

/** Build a URL that matches a stored cookie so it can be removed by name. */
function cookieRemovalUrl(cookie: Cookie): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  const scheme = cookie.secure ? 'https' : 'http'
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'
  return `${scheme}://${host}${path}`
}
