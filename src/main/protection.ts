import { app, type Session } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import adblock from 'adblock-rs'
import { DEFAULT_PROTECTION } from '@shared/types'
import type { ConfigStore } from './config'
import type { TabKind } from '@shared/types'

const STANDARD_LISTS = [
  ['easylist', 'https://easylist.to/easylist/easylist.txt'],
  ['ubo-filters', 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt'],
  ['brave-specific', 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt'],
  ['brave-unbreak', 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt']
] as const
const PRIVACY_LISTS = [
  ['easyprivacy', 'https://easylist.to/easylist/easyprivacy.txt'],
  ['ubo-privacy', 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt']
] as const
const LISTS = [...STANDARD_LISTS, ...PRIVACY_LISTS] as const
const FALLBACK = [
  '||doubleclick.net^', '||googlesyndication.com^', '||googleadservices.com^',
  '||adservice.google.com^', '||pagead2.googlesyndication.com^',
  '||google-analytics.com^', '||facebook.net^', '||adnxs.com^', '||adsrvr.org^',
  '||taboola.com^', '||outbrain.com^', '||criteo.com^', '||rubiconproject.com^',
  '||pubmatic.com^', '||openx.net^', '||casalemedia.com^', '||smartadserver.com^',
  '||amazon-adsystem.com^', '||moatads.com^', '||scorecardresearch.com^',
  '||advertising.com^'
].join('\n')

type Engine = InstanceType<typeof adblock.Engine>

function buildEngine(lists: string[]): Engine {
  const set = new adblock.FilterSet()
  set.addFilters(lists.join('\n'))
  return new adblock.Engine(set)
}

function filterType(resourceType: string): string {
  const types: Record<string, string> = {
    mainFrame: 'document', subFrame: 'subdocument', stylesheet: 'stylesheet',
    script: 'script', image: 'image', font: 'font', media: 'media',
    xhr: 'xmlhttprequest', fetch: 'xmlhttprequest', ping: 'ping',
    object: 'object', websocket: 'websocket'
  }
  return types[resourceType] ?? 'other'
}

export class ProtectionService {
  private standard = buildEngine([FALLBACK])
  private strict = this.standard
  private readonly blockedBySite = new Map<string, number>()
  private readonly sessionExceptions: Record<'private' | 'tor', Set<string>> = { private: new Set(), tor: new Set() }
  private readonly dataDir = join(app.getPath('userData'), 'protection')

  constructor(private readonly config: ConfigStore) {
    mkdirSync(this.dataDir, { recursive: true })
    const cached = LISTS.map(([name]) => {
      const path = join(this.dataDir, `${name}.txt`)
      try { return readFileSync(path, 'utf8') } catch { return '' }
    })
    if (cached.some(Boolean)) this.install(cached)
    void this.refreshLists()
  }

  private settings() { return this.config.get().protection ?? DEFAULT_PROTECTION }

  setSiteException(origin: string, allowed: boolean, kind: TabKind) {
    if (kind === 'normal') {
      const current = this.settings()
      const siteExceptions = new Set(current.siteExceptions)
      if (allowed) siteExceptions.add(origin)
      else siteExceptions.delete(origin)
      return this.config.setProtection({ ...current, siteExceptions: [...siteExceptions] })
    }
    if (allowed) this.sessionExceptions[kind].add(origin)
    else this.sessionExceptions[kind].delete(origin)
    return this.config.get()
  }

  isExcepted(origin: string, kind: TabKind): boolean {
    return kind === 'normal'
      ? this.settings().siteExceptions.includes(origin)
      : this.sessionExceptions[kind].has(origin)
  }

  clearSession(kind: 'private' | 'tor'): void { this.sessionExceptions[kind].clear() }

  shouldBlock(details: Electron.OnBeforeRequestListenerDetails, kind: TabKind = 'normal'): boolean {
    const settings = this.settings()
    if (settings.level === 'off') return false
    let source: string
    try { source = (details as typeof details & { initiator?: string }).initiator || details.referrer || '' } catch { source = '' }
    let origin = ''
    try { origin = new URL(source).origin } catch { /* no initiator */ }
    const exceptionOrigin = details.resourceType === 'mainFrame'
      ? (() => { try { return new URL(details.url).origin } catch { return origin } })()
      : origin
    if (this.isExcepted(exceptionOrigin, kind)) return false
    const type = filterType(details.resourceType)
    if (settings.blockScripts && type === 'script') return true
    try {
      const engine = settings.level === 'strict' ? this.strict : this.standard
      const result = engine.check(details.url, source || details.url, type, details.method.toLowerCase())
      const blocked = typeof result === 'boolean' ? result : result.should_block
      if (blocked && origin) this.blockedBySite.set(origin, (this.blockedBySite.get(origin) ?? 0) + 1)
      return blocked
    } catch {
      return false
    }
  }

  cosmeticScript(url: string, kind: TabKind = 'normal'): string {
    if (this.settings().level === 'off') return ''
    try { if (this.isExcepted(new URL(url).origin, kind)) return '' } catch { return '' }
    try {
      const engine = this.settings().level === 'strict' ? this.strict : this.standard
      const result = engine.urlCosmeticResources(url)
      const selectors = Array.isArray(result.hide_selectors) ? result.hide_selectors : []
      if (!selectors.length) return ''
      return `(()=>{const s=${JSON.stringify(selectors.join(','))};const apply=()=>{try{document.querySelectorAll(s).forEach(e=>e.remove())}catch{}};apply();new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true})})()`
    } catch { return '' }
  }

  countFor(url: string): number {
    try { return this.blockedBySite.get(new URL(url).origin) ?? 0 } catch { return 0 }
  }

  installCookiePolicy(session: Session, kind: TabKind): void {
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      if (this.settings().level !== 'strict') { callback({ requestHeaders: details.requestHeaders }); return }
      const source = (details as typeof details & { initiator?: string }).initiator || details.referrer || ''
      try {
        if (!this.isExcepted(new URL(source).origin, kind) && new URL(source).origin !== new URL(details.url).origin) {
          const headers = { ...details.requestHeaders }
          for (const name of Object.keys(headers)) if (name.toLowerCase() === 'cookie') delete headers[name]
          callback({ requestHeaders: headers })
          return
        }
      } catch { /* without an initiator, leave browser cookie behavior intact */ }
      callback({ requestHeaders: details.requestHeaders })
    })
    session.webRequest.onHeadersReceived((details, callback) => {
      if (this.settings().level !== 'strict') { callback({ responseHeaders: details.responseHeaders }); return }
      try {
        const source = (details as typeof details & { initiator?: string }).initiator || details.referrer || ''
        if (!this.isExcepted(new URL(source).origin, kind) && new URL(source).origin !== new URL(details.url).origin) {
          const headers = { ...(details.responseHeaders ?? {}) }
          for (const name of Object.keys(headers)) if (name.toLowerCase() === 'set-cookie') delete headers[name]
          callback({ responseHeaders: headers })
          return
        }
      } catch { /* leave the response unchanged */ }
      callback({ responseHeaders: details.responseHeaders })
    })
  }

  private install(lists: string[]): void {
    const standard = lists.slice(0, STANDARD_LISTS.length).filter(Boolean)
    const strict = lists.filter(Boolean)
    this.standard = buildEngine([FALLBACK, ...standard])
    this.strict = buildEngine([FALLBACK, ...strict])
  }

  private async refreshLists(): Promise<void> {
    const fresh = LISTS.every(([name]) => {
      try { return Date.now() - statSync(join(this.dataDir, `${name}.txt`)).mtimeMs < 24 * 60 * 60 * 1000 } catch { return false }
    })
    if (fresh) return
    const lists = LISTS.map(([name]) => {
      try { return readFileSync(join(this.dataDir, `${name}.txt`), 'utf8') } catch { return '' }
    })
    await Promise.all(LISTS.map(async ([name, url], index) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) return
        const body = await response.text()
        if (body.length < 100 || body.length > 12_000_000) return
        writeFileSync(join(this.dataDir, `${name}.txt`), body, 'utf8')
        lists[index] = body
      } catch { /* retain the last known good lists */ }
    }))
    this.install(lists)
  }
}
