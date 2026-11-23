/**
 * HTTPS policy and HTTP warning exceptions.
 *
 * Normal tabs persist "always allow HTTP" exceptions in config.json. Private and
 * Tor tabs keep them in memory and drop them with the session.
 */

import { randomUUID } from 'node:crypto'
import type { HttpsMode, TabKind } from '@shared/types'
import type { ConfigStore } from './config'
import { isOnionHost } from './tor/guard'

const TOKEN_TTL_MS = 5 * 60_000

/**
 * Dedicated identity-provider login hosts, not general sites. A `window.open` popup
 * to one of these keeps its `window.opener` (see `wireTab`'s window-open handler) so
 * the OAuth popup flow can `postMessage` the result back; every other popup is denied
 * and reopened as a plain tab, which loses that relationship but keeps the browser
 * from spawning arbitrary popup windows.
 *
 * In practice most OAuth buttons open a same-origin relay URL first (e.g. Figma's
 * Google button opens `/start_google_sso` on figma.com, which then redirects to
 * accounts.google.com), so `window.open`'s resolved URL rarely names the identity
 * provider at open time. `isDialogSizedPopupFeatures` below catches those by their
 * `window.open` dimensions instead; this host list stays as a second, independent
 * signal for the rarer case where a site opens the provider's URL directly.
 */
const AUTH_POPUP_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com'
])

export function isAuthPopupUrl(url: string): boolean {
  try {
    return AUTH_POPUP_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

const DIALOG_POPUP_MIN = 300
const DIALOG_POPUP_MAX = 800

/**
 * True for `window.open` calls sized like a deliberate sign-in/payment dialog (both
 * width and height given, each in a modest, human-dialog range) rather than a full
 * page or an undersized/unsized ad popup. `features` is the comma-separated string
 * Electron's `setWindowOpenHandler` hands back, e.g. "width=600,height=600".
 */
export function isDialogSizedPopupFeatures(features: string): boolean {
  let width: number | null = null
  let height: number | null = null
  for (const part of features.split(',')) {
    const [key, value] = part.split('=').map((piece) => piece.trim())
    if (key === 'width') width = Number(value)
    else if (key === 'height') height = Number(value)
  }
  if (width === null || height === null || Number.isNaN(width) || Number.isNaN(height)) {
    return false
  }
  return (
    width >= DIALOG_POPUP_MIN &&
    width <= DIALOG_POPUP_MAX &&
    height >= DIALOG_POPUP_MIN &&
    height <= DIALOG_POPUP_MAX
  )
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  )
}

export function isHttpExemptUrl(value: string | URL): boolean {
  let url: URL
  try {
    url = value instanceof URL ? value : new URL(value)
  } catch {
    return false
  }
  return isLoopbackHost(url.hostname) || isOnionHost(url.hostname.toLowerCase())
}

/** True when a typed clearnet URL should be attempted over HTTPS first. */
export function shouldUpgradeHttp(value: string, mode: HttpsMode): boolean {
  if (mode === 'off') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' && !isHttpExemptUrl(url)
}

export function upgradeToHttps(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  if (url.protocol !== 'http:') return value
  url.protocol = 'https:'
  if (url.port === '80') url.port = ''
  return url.toString()
}

/** An NCC endpoint that is plaintext, not onion and not loopback. */
export function nccEndpointNeedsWarning(endpoint: {
  url: string
  protocol: string
  family: string
}): boolean {
  if (endpoint.protocol !== 'http' || endpoint.family === 'onion') return false
  try {
    return !isLoopbackHost(new URL(endpoint.url).hostname)
  } catch {
    return true
  }
}

export function nccHttpKey(pubkey: string, service: string): string {
  return `ncc://${pubkey}/${service}`
}

export function webHttpKey(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export class HttpPolicy {
  private readonly ephemeral = new Set<string>()
  private readonly tokens = new Map<string, { key: string; expires: number }>()

  constructor(
    private readonly kind: TabKind,
    private readonly config: ConfigStore
  ) {}

  mode(): HttpsMode {
    return this.config.get().httpsMode
  }

  warn(): boolean {
    return this.config.get().warnInsecure
  }

  isAllowed(key: string): boolean {
    if (!key) return false
    if (this.kind === 'normal') return this.config.get().httpExceptions.includes(key)
    return this.ephemeral.has(key)
  }

  /** Record a user-approved HTTP exception. */
  allow(key: string): void {
    if (!key) return
    if (this.kind === 'normal') this.config.allowHttp(key)
    else this.ephemeral.add(key)
  }

  /** One-time token embedded in an NCC HTTP warning page. */
  createToken(key: string): string {
    this.pruneTokens()
    const token = randomUUID()
    this.tokens.set(token, { key, expires: Date.now() + TOKEN_TTL_MS })
    return token
  }

  consumeToken(token: string): string | null {
    this.pruneTokens()
    const entry = this.tokens.get(token)
    if (!entry) return null
    this.tokens.delete(token)
    return entry.key
  }

  ephemeralExceptions(): string[] {
    return this.kind === 'normal' ? [] : [...this.ephemeral]
  }

  clearEphemeral(): void {
    this.ephemeral.clear()
    this.tokens.clear()
  }

  private pruneTokens(): void {
    const now = Date.now()
    for (const [token, entry] of this.tokens) {
      if (entry.expires <= now) this.tokens.delete(token)
    }
  }
}
