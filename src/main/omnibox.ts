/**
 * Address-bar suggestion aggregation.
 *
 * Pure ranking over local sources only: bookmarks, normal-tab history, open tabs of
 * the same kind, and NCC service names already seen for a typed npub. No query is
 * ever sent to a search engine from here.
 */

import { buildNccUrl, parseNccAddress } from '@shared/ncc-url'
import {
  classifyOmniboxInput,
  omniboxActionLabel,
  type OmniboxContext,
  type OmniboxTarget
} from '@shared/omnibox'
import type { BookmarkStore } from './bookmarks'
import type { BrowsingEntry, HistoryStore } from './history'
import type { AppConfig, OmniboxSuggestion, TabKind } from '@shared/types'

export interface OmniboxTab {
  id: string
  kind: TabKind
  title: string
  url: string
}

export interface OmniboxDeps {
  history: HistoryStore
  bookmarks: BookmarkStore
  config: () => AppConfig
  now?: () => number
}

interface Candidate {
  suggestion: OmniboxSuggestion
  score: number
}

const NCC_INPUT_RE =
  /^(?:ncc:\/\/)?(npub1[02-9ac-hj-np-z]+|[0-9a-f]{64})(?:\/([A-Za-z0-9._~-]*))?$/i

const SOURCE_PRIORITY: Record<OmniboxSuggestion['kind'], number> = {
  action: 50,
  service: 40,
  tab: 30,
  bookmark: 20,
  history: 10
}

export class OmniboxService {
  constructor(private readonly deps: OmniboxDeps) {}

  context(kind: TabKind): OmniboxContext {
    const config = this.deps.config()
    return {
      engine: config.searchEngine,
      custom: config.searchEngineCustom,
      useOnionSearch: config.useOnionSearch,
      httpsMode: config.httpsMode,
      tabKind: kind
    }
  }

  classify(input: string, kind: TabKind): OmniboxTarget {
    return classifyOmniboxInput(input, this.context(kind))
  }

  recordVisit(url: string, title: string, kind: TabKind): void {
    if (kind !== 'normal') return
    this.deps.history.record(url, title)
  }

  updateTitle(url: string, title: string, kind: TabKind): void {
    if (kind !== 'normal') return
    this.deps.history.setTitle(url, title)
  }

  clearHistory(): void {
    this.deps.history.clear()
  }


  suggest(
    input: string,
    kind: TabKind,
    tabs: readonly OmniboxTab[] = [],
    limit = 8
  ): OmniboxSuggestion[] {
    const text = input.trim()
    const target = this.classify(text, kind)

    // A pasted private key must not even produce a matching bookmark row.
    if (target.kind === 'invalid' && target.code === 'secret-key') return []

    const candidates: Candidate[] = []
    const action = actionSuggestion(target)
    if (action) candidates.push({ suggestion: action, score: 1000 })

    if (text) {
      const bookmarks = this.deps.bookmarks.list()
      const history = kind === 'normal' ? this.deps.history.list(1000) : []
      const serviceSources = kind === 'normal' ? history : []

      const bookmarkByUrl = new Map(bookmarks.map((bookmark) => [bookmark.url, bookmark]))

      for (const bookmark of bookmarks) {
        const score = scoreText(text, bookmark.title, bookmark.url)
        if (score === null) continue
        candidates.push({
          score: score + 60,
          suggestion: {
            id: `bookmark:${bookmark.url}`,
            kind: 'bookmark',
            icon: 'star',
            title: bookmark.title,
            detail: 'Bookmark',
            url: bookmark.url
          }
        })
      }

      for (const entry of history) {
        const score = scoreText(text, entry.title, entry.url)
        if (score === null) continue
        // A bookmark with the same URL is the better row.
        if (bookmarkByUrl.has(entry.url)) continue
        candidates.push({
          score: score + visitBoost(entry, this.now()),
          suggestion: {
            id: `history:${entry.url}`,
            kind: 'history',
            icon: 'clock',
            title: entry.title,
            detail: entry.visits > 1 ? `History · ${entry.visits} visits` : 'History',
            url: entry.url
          }
        })
      }

      for (const tab of tabs) {
        if (tab.kind !== kind || !tab.url) continue
        const score = scoreText(text, tab.title, tab.url)
        if (score === null) continue
        candidates.push({
          score: score + 80,
          suggestion: {
            id: `tab:${tab.id}`,
            kind: 'tab',
            icon: 'tab',
            title: tab.title,
            detail: 'Switch to tab',
            url: tab.url,
            tabId: tab.id
          }
        })
      }

      for (const suggestion of serviceSuggestions(text, serviceSources, bookmarks)) {
        candidates.push({ suggestion, score: 700 })
      }
    } else {
      for (const suggestion of this.topSites(kind)) {
        candidates.push({ suggestion, score: 1 })
      }
    }

    const merged = mergeCandidates(candidates)
    const keepAction = merged.filter((candidate) => candidate.suggestion.kind === 'action')
    const rest = merged.filter((candidate) => candidate.suggestion.kind !== 'action')
    // Top sites keep their recency/bookmark order; typed input is ranked.
    const ordered = text ? rest.sort(compareCandidates) : rest
    return [...keepAction, ...ordered]
      .slice(0, Math.max(1, limit))
      .map((candidate) => candidate.suggestion)
  }

  private topSites(kind: TabKind): OmniboxSuggestion[] {
    const bookmarks = this.deps.bookmarks
      .list()
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map<OmniboxSuggestion>((bookmark) => ({
        id: `bookmark:${bookmark.url}`,
        kind: 'bookmark',
        icon: 'star',
        title: bookmark.title,
        detail: 'Bookmark',
        url: bookmark.url
      }))

    if (kind !== 'normal') return bookmarks.slice(0, 6)

    const seen = new Set(bookmarks.map((bookmark) => bookmark.url))
    const recent = this.deps.history
      .list(10)
      .filter((entry) => !seen.has(entry.url))
      .map<OmniboxSuggestion>((entry) => ({
        id: `history:${entry.url}`,
        kind: 'history',
        icon: 'clock',
        title: entry.title,
        detail: entry.visits > 1 ? `History · ${entry.visits} visits` : 'History',
        url: entry.url
      }))

    return [...recent.slice(0, 6 - Math.min(6, bookmarks.length)), ...bookmarks.slice(0, 6)].slice(0, 6)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
}

function actionSuggestion(target: OmniboxTarget): OmniboxSuggestion | null {
  switch (target.kind) {
    case 'invalid':
      return null
    case 'search':
      return {
        id: 'action:search',
        kind: 'action',
        icon: 'search',
        title: omniboxActionLabel(target),
        detail: 'Press Enter',
        url: target.url
      }
    case 'ncc':
      return {
        id: 'action:ncc',
        kind: 'action',
        icon: 'ncc',
        title: omniboxActionLabel(target),
        detail: 'NCC service',
        url: target.url
      }
    case 'web':
      return {
        id: 'action:web',
        kind: 'action',
        icon: 'web',
        title: omniboxActionLabel(target),
        detail: 'Press Enter',
        url: target.url
      }
  }
}

function serviceSuggestions(
  input: string,
  history: readonly BrowsingEntry[],
  bookmarks: readonly { url: string }[]
): OmniboxSuggestion[] {
  const match = NCC_INPUT_RE.exec(input)
  if (!match) return []
  const pubkey = match[1].toLowerCase()
  const prefix = (match[2] ?? '').toLowerCase()

  const services = new Set<string>()
  for (const url of [...bookmarks.map((bookmark) => bookmark.url), ...history.map((entry) => entry.url)]) {
    try {
      const address = parseNccAddress(url)
      if (address.pubkey.toLowerCase() === pubkey) services.add(address.service)
    } catch {
      // Not an NCC URL; nothing to complete.
    }
  }

  return [...services]
    .filter((service) => service.toLowerCase().startsWith(prefix) && service.toLowerCase() !== prefix)
    .sort()
    .slice(0, 5)
    .map((service) => ({
      id: `service:${pubkey}:${service}`,
      kind: 'service' as const,
      icon: 'ncc' as const,
      title: `ncc://${shorten(pubkey)}/${service}`,
      detail: 'NCC service',
      url: buildNccUrl({ pubkey, service, trailingSlash: true })
    }))
}

function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const key =
      candidate.suggestion.kind === 'tab'
        ? candidate.suggestion.id
        : candidate.suggestion.kind === 'action'
          ? candidate.suggestion.id
          : candidate.suggestion.url
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, candidate)
      continue
    }
    const currentPriority = SOURCE_PRIORITY[candidate.suggestion.kind]
    const existingPriority = SOURCE_PRIORITY[existing.suggestion.kind]
    if (
      candidate.score > existing.score ||
      (candidate.score === existing.score && currentPriority > existingPriority)
    ) {
      byKey.set(key, candidate)
    }
  }
  return [...byKey.values()]
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score
  return SOURCE_PRIORITY[b.suggestion.kind] - SOURCE_PRIORITY[a.suggestion.kind]
}

function scoreText(query: string, title: string, url: string): number | null {
  const q = query.toLowerCase()
  const t = title.toLowerCase()
  const u = url.toLowerCase()
  if (!q) return null

  if (u === q || u === `${q}/`) return 800
  if (u.startsWith(q)) return 520
  if (t.startsWith(q)) return 480
  if (new RegExp(`(^|[\\s/._-])${escapeRegExp(q)}`).test(t)) return 340
  if (u.includes(q)) return 240
  if (t.includes(q)) return 200

  const words = q.split(/\s+/).filter(Boolean)
  if (words.length > 1 && words.every((word) => t.includes(word) || u.includes(word))) {
    return 140
  }
  return null
}

function visitBoost(entry: BrowsingEntry, now: number): number {
  const countBoost = Math.min(40, Math.log2(entry.visits + 1) * 8)
  const ageDays = Math.max(0, (now - entry.lastVisit) / 86_400_000)
  return countBoost + Math.max(0, 30 - ageDays)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function shorten(pubkey: string): string {
  if (pubkey.length <= 20) return pubkey
  return `${pubkey.slice(0, 10)}…${pubkey.slice(-4)}`
}
