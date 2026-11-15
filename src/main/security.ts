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
