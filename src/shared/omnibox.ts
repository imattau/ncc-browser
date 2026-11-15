/**
 * Address-bar input classification.
 *
 * One shared, pure answer to "what happens if I press Enter?", used both by the
 * navigation path in the main process and by the suggestion dropdown in the chrome.
 * That keeps the row label and the actual action from ever disagreeing.
 */

import { buildNccUrl, looksLikeNccInput, parseNccAddress } from './ncc-url'
import {
  buildSearchUrl,
  resolveSearchTemplate,
  type SearchSettings
} from './search'
import type { HttpsMode, TabKind } from './types'

export interface OmniboxContext extends SearchSettings {
  httpsMode: HttpsMode
  tabKind: TabKind
}

export type OmniboxTarget =
  | { kind: 'ncc'; url: string }
  | { kind: 'web'; url: string }
  | { kind: 'search'; url: string; query: string; engineLabel: string }
  | { kind: 'invalid'; code: string; message: string }

// Anchored to a word boundary so a key pasted with surrounding text is still caught.
const SECRET_KEY_RE = /\b(nsec|ncryptsec)1[02-9ac-hj-np-z]{10,}/i
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const HOST_RE = /^(\[[0-9a-f:.]+\]|[^\s/?#@:]+)(?::(\d{1,5}))?([/?#].*)?$/i

export function classifyOmniboxInput(raw: string, context: OmniboxContext): OmniboxTarget {
  const text = raw.trim()
  if (!text) return invalid('Enter an address or search')

  // Never hand a private key to a search engine — or to anything else.
  if (SECRET_KEY_RE.test(text)) {
    return invalid(
      'secret-key',
      'That looks like a private key. It was ignored — never paste an nsec into an address bar.'
    )
  }

  const forcedSearch = text.startsWith('?')
  const query = forcedSearch ? text.slice(1).trim() : text

  if (!forcedSearch) {
    if (/^ncc:/i.test(text) || looksLikeNccInput(text)) {
      try {
        const address = parseNccAddress(text)
        return {
          kind: 'ncc',
          url: buildNccUrl({ ...address, trailingSlash: !address.path })
        }
      } catch (error) {
        return invalid(
          'invalid-address',
          error instanceof Error ? error.message : 'That is not a valid NCC address'
        )
      }
    }

    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return { kind: 'web', url: text }
        }
      } catch {
        // Fall through to the invalid-address message below.
      }
      return invalid('invalid-address', 'That is not a valid URL')
    }

    const scheme = SCHEME_RE.exec(text) ?? /^([a-z][a-z0-9+.-]*):/i.exec(text)
    if (scheme && !/^[a-z][a-z0-9+.-]*:\d+([/?#]|$)/i.test(text)) {
      return invalid(
        'unsupported-scheme',
        `Only ncc://, http:// and https:// addresses are supported (got ${scheme[1]}:)`
      )
    }

    const host = parseHostInput(text)
    if (host && 'error' in host) return invalid('invalid-address', host.error)
    if (host) return { kind: 'web', url: host.url }
  }

  if (!query) return invalid('Enter a search')

  const resolved = resolveSearchTemplate(context, context.tabKind)
  return {
    kind: 'search',
    url: buildSearchUrl(context, query, context.tabKind),
    query,
    engineLabel: resolved.label
  }
}

export function omniboxActionLabel(target: OmniboxTarget): string {
  switch (target.kind) {
    case 'search':
      return `Search ${target.engineLabel} for "${truncate(target.query, 70)}"`
    case 'ncc':
    case 'web':
      return `Open ${target.url}`
    case 'invalid':
      return target.message
  }
}

/** True when the typed text would be treated as a search rather than a URL. */
export function looksLikeSearch(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (value.startsWith('?')) return value.length > 1
  if (SECRET_KEY_RE.test(value)) return false
  if (value.includes('://') || looksLikeNccInput(value)) return false
  return parseHostInput(value) === null
}

type HostResult = { url: string } | { error: string }

/**
 * Turn a scheme-less host into a URL, or `null` when it is not host-like and should
 * go to the search engine instead.
 */
export function parseHostInput(raw: string): HostResult | null {
  const text = raw.trim()
  if (!text || /\s/.test(text)) return null
  if (SCHEME_RE.test(text)) return null
  if (text.includes('@')) return null

  const match = HOST_RE.exec(text)
  if (!match) return null

  const rawHost = match[1].replace(/\.$/, '')
  const port = match[2]
  const rest = match[3] ?? ''
  if (!rawHost) return null

  const host = rawHost.toLowerCase()
  const bracketed = host.startsWith('[')
  const ipv6 = bracketed && host.includes(':')
  const ipv4 = IPV4_RE.test(host)

  if (port) {
    const value = Number(port)
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      return { error: `"${port}" is not a valid port` }
    }
  }

  if (ipv4) {
    if (host.split('.').some((part) => Number(part) > 255)) {
      return { error: `"${rawHost}" is not a valid IP address` }
    }
  }

  const local = isLocalHost(host)
  const onion = host.endsWith('.onion')
  const dotted = host.split('.').length > 1 && isKnownTld(host)

  // A single label such as `nostr` is a search, matching browser behaviour.
  if (!ipv4 && !ipv6 && !local && !onion && !dotted) return null

  const scheme = local || ipv4 || ipv6 || onion ? 'http' : 'https'
  return { url: `${scheme}://${rawHost}${port ? `:${port}` : ''}${rest}` }
}

function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '')
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.local') ||
    bare === '::1' ||
    bare === '0.0.0.0' ||
    /^127\./.test(bare)
  )
}

function isKnownTld(host: string): boolean {
  const labels = host.replace(/^\[/, '').replace(/\]$/, '').split('.')
  const tld = labels[labels.length - 1] ?? ''
  if (!tld) return false
  return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld)
}

function invalid(code: string, message = code): OmniboxTarget {
  return { kind: 'invalid', code, message }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
