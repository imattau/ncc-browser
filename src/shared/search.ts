/**
 * Search-engine definitions and template validation.
 *
 * Search templates navigate to ordinary web URLs or NCC service addresses. Templates
 * are plain strings with a `%s` placeholder; nothing here performs network access.
 */

import type { TabKind } from './types'
import { parseNccAddress } from './ncc-url'

export type SearchEngineId =
  | 'duckduckgo'
  | 'brave'
  | 'startpage'
  | 'google'
  | 'bing'
  | 'searx'
  | 'custom'

export interface SearchEngineDefinition {
  id: SearchEngineId
  label: string
  /** Built-in template. User-configurable engines resolve theirs from settings. */
  template?: string
  /** Used by full Tor tabs when onion search is enabled. */
  onionTemplate?: string
  /** `searx` takes an instance URL, `custom` takes a full `%s` template. */
  configurable?: 'searx' | 'custom'
  /** Reads naturally after the verb, e.g. "Search DuckDuckGo for …". */
  actionLabel?: string
}

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'duckduckgo'

/**
 * DuckDuckGo publishes an onion service and Tor Browser uses it as its default
 * engine. It is only ever selected for full Tor tabs.
 */
const DDG_ONION =
  'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=%s'

export const SEARCH_ENGINES: SearchEngineDefinition[] = [
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    template: 'https://duckduckgo.com/?q=%s',
    onionTemplate: DDG_ONION
  },
  { id: 'brave', label: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  {
    id: 'startpage',
    label: 'Startpage',
    template: 'https://www.startpage.com/sp/search?query=%s'
  },
  { id: 'google', label: 'Google', template: 'https://www.google.com/search?q=%s' },
  { id: 'bing', label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  {
    id: 'searx',
    label: 'SearXNG',
    actionLabel: 'SearXNG',
    configurable: 'searx',
    template: 'https://searx.be/search?q=%s'
  },
  {
    id: 'custom',
    label: 'Custom',
    actionLabel: 'the custom search engine',
    configurable: 'custom'
  }
]

export interface SearchSettings {
  engine: SearchEngineId
  /** SearXNG base URL, or an HTTP(S)/NCC `%s` template for the custom engine. */
  custom: string
  /** Substitute the engine's onion endpoint inside full Tor tabs. */
  useOnionSearch: boolean
}

export interface ResolvedSearch {
  template: string
  engine: SearchEngineId
  label: string
  /** Set when the configured engine is unusable and DuckDuckGo was substituted. */
  error: string | null
}

export type TemplateResult = { ok: true; template: string } | { ok: false; error: string }

export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return SEARCH_ENGINES.some((engine) => engine.id === value)
}

export function searchEngine(id: SearchEngineId): SearchEngineDefinition {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES[0]
}

export function searchEngineLabel(id: SearchEngineId): string {
  return searchEngine(id).label
}

/** Hosts that may use plaintext HTTP for a search endpoint. */
export function isExemptSearchHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    host.endsWith('.onion')
  )
}

export function validateSearchTemplate(input: string): TemplateResult {
  const value = input.trim()
  if (!value) return { ok: false, error: 'Enter a search URL' }
  if (!value.includes('%s')) {
    return { ok: false, error: 'The search URL must contain %s where the query goes' }
  }

  let url: URL
  try {
    url = new URL(value.split('%s').join('test'))
  } catch {
    return { ok: false, error: 'That is not a valid URL' }
  }
  if (url.protocol === 'ncc:') {
    try {
      parseNccAddress(value.split('%s').join('test'))
    } catch {
      return { ok: false, error: 'Use a valid ncc:// address for the search URL' }
    }
    return { ok: true, template: value }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Use an http://, https:// or ncc:// search URL' }
  }
  if (url.protocol === 'http:' && !isExemptSearchHost(url.hostname)) {
    return {
      ok: false,
      error: 'Use https:// for the search URL (plaintext is allowed only for loopback and .onion)'
    }
  }
  return { ok: true, template: value }
}

/** Turn a SearXNG instance URL into a `%s` search template. */
export function searxTemplate(base: string): TemplateResult {
  const value = base.trim()
  if (!value) return { ok: false, error: 'Enter the SearXNG instance URL' }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: 'That is not a valid SearXNG URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Use an http:// or https:// SearXNG URL' }
  }
  if (url.protocol === 'http:' && !isExemptSearchHost(url.hostname)) {
    return { ok: false, error: 'Use https:// for the SearXNG instance' }
  }

  const path = url.pathname.replace(/\/+$/, '')
  const searchPath = path.endsWith('/search') ? path : `${path}/search`
  return validateSearchTemplate(`${url.origin}${searchPath}?q=%s`)
}

/** Resolve the active engine to a concrete template, falling back to DuckDuckGo. */
export function resolveSearchTemplate(
  settings: SearchSettings,
  kind: TabKind = 'normal'
): ResolvedSearch {
  const engine = searchEngine(settings.engine)
  let template = engine.template ?? SEARCH_ENGINES[0].template ?? ''
  let error: string | null = null

  if (engine.configurable === 'searx') {
    const result = searxTemplate(settings.custom)
    if (result.ok) template = result.template
    else error = result.error
  } else if (engine.configurable === 'custom') {
    const result = validateSearchTemplate(settings.custom)
    if (result.ok) template = result.template
    else error = result.error
  }

  if (error) {
    template = SEARCH_ENGINES[0].template ?? ''
  }

  const onion = kind === 'tor' && settings.useOnionSearch ? engine.onionTemplate : undefined
  return {
    template: onion ?? template,
    engine: error ? 'duckduckgo' : engine.id,
    label: error
      ? SEARCH_ENGINES[0].actionLabel ?? SEARCH_ENGINES[0].label
      : engine.actionLabel ?? engine.label,
    error
  }
}

export function buildSearchUrl(
  settings: SearchSettings,
  query: string,
  kind: TabKind = 'normal'
): string {
  const { template } = resolveSearchTemplate(settings, kind)
  return template.split('%s').join(encodeURIComponent(query))
}
