import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeRelayEntries, defaultRelays, relayUrls } from '@shared/relays'
import {
  DEFAULT_SEARCH_ENGINE,
  isSearchEngineId,
  type SearchEngineId
} from '@shared/search'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_HTTPS_MODE,
  DEFAULT_PASSWORD_CONFIG,
  DEFAULT_PROTECTION,
  DEFAULT_TOR_SOCKS,
  normalizeAppearance,
  normalizePasswordConfig,
  normalizeProtection,
  type AppearanceConfig,
  type AppConfig,
  type HttpsMode,
  type PasswordConfig,
  type ProtectionConfig,
  type RelayEntry,
  type TorMode
} from '@shared/types'

/**
 * Tiny JSON settings store in `userData`: relay list, NIP-65 gossip, and whether a
 * fresh NCC-02 service record is required.
 */
export class ConfigStore {
  private filePath: string | null = null
  private config: AppConfig | null = null

  private get path(): string {
    this.filePath ??= join(app.getPath('userData'), 'config.json')
    return this.filePath
  }

  get(): AppConfig {
    this.config ??= this.read()
    return this.config
  }

  getRelays(): string[] {
    return relayUrls(this.get().relays)
  }

  getRelayEntries(): RelayEntry[] {
    return this.get().relays.map((entry) => ({ ...entry }))
  }

  setRelays(input: unknown): AppConfig {
    const relays = normalizeRelayEntries(input)
    this.config = { ...this.get(), relays }
    this.write()
    return this.get()
  }

  /** Replace one relay entry after its locator resolved to a new endpoint. */
  replaceRelayEntry(currentUrl: string, next: RelayEntry): AppConfig {
    const current = this.get()
    this.config = {
      ...current,
      relays: current.relays.map((entry) => (entry.url === currentUrl ? next : entry))
    }
    this.write()
    return this.get()
  }

  /** Mark an entry stale without changing its endpoint. */
  markRelayStale(url: string, stale: boolean): AppConfig {
    const current = this.get()
    const entry = current.relays.find((candidate) => candidate.url === url)
    if (!entry || (entry.stale === true) === stale) return current
    this.config = {
      ...current,
      relays: current.relays.map((candidate) =>
        candidate.url === url
          ? { ...candidate, ...(stale ? { stale: true } : { stale: false }) }
          : candidate
      )
    }
    this.write()
    return this.get()
  }

  setGossip(value: unknown): AppConfig {
    this.config = { ...this.get(), gossip: value === true }
    this.write()
    return this.get()
  }

  setAnchorRequired(value: unknown): AppConfig {
    this.config = { ...this.get(), anchorRequired: value === true }
    this.write()
    return this.get()
  }

  setExternalAddressChecks(value: unknown): AppConfig {
    const externalAddressChecks =
      value === 'always' || value === 'never' ? value : ('ask' as const)
    this.config = { ...this.get(), externalAddressChecks }
    this.write()
    return this.get()
  }

  setPreferTor(value: unknown): AppConfig {
    this.config = { ...this.get(), preferTor: value === true }
    this.write()
    return this.get()
  }

  setEphemeralSigner(value: unknown): AppConfig {
    this.config = { ...this.get(), ephemeralSigner: value === true }
    this.write()
    return this.get()
  }

  setTorMode(value: unknown): AppConfig {
    const torMode: TorMode = value === 'local' ? 'local' : 'auto'
    this.config = { ...this.get(), torMode }
    this.write()
    return this.get()
  }

  setTorSocks(value: unknown): AppConfig {
    const torSocks = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TOR_SOCKS
    this.config = { ...this.get(), torSocks }
    this.write()
    return this.get()
  }

  setHttpsMode(value: unknown): AppConfig {
    const httpsMode: HttpsMode =
      value === 'off' || value === 'only' ? value : value === 'prefer' ? 'prefer' : DEFAULT_HTTPS_MODE
    this.config = { ...this.get(), httpsMode }
    this.write()
    return this.get()
  }

  setProtection(value: unknown): AppConfig {
    const protection: ProtectionConfig = normalizeProtection({ ...this.get().protection, ...(value && typeof value === 'object' ? value : {}) })
    this.config = { ...this.get(), protection }
    this.write()
    return this.get()
  }

  setWarnInsecure(value: unknown): AppConfig {
    this.config = { ...this.get(), warnInsecure: value === true }
    this.write()
    return this.get()
  }

  allowHttp(key: string): AppConfig {
    const value = key.trim()
    if (!value) return this.get()
    const httpExceptions = [...new Set([...this.get().httpExceptions, value])].slice(-200)
    this.config = { ...this.get(), httpExceptions }
    this.write()
    return this.get()
  }

  removeHttpException(key: string): AppConfig {
    const httpExceptions = this.get().httpExceptions.filter((entry) => entry !== key)
    this.config = { ...this.get(), httpExceptions }
    this.write()
    return this.get()
  }

  clearHttpExceptions(): AppConfig {
    this.config = { ...this.get(), httpExceptions: [] }
    this.write()
    return this.get()
  }

  setSearchConfig(input: {
    engine?: unknown
    custom?: unknown
    useOnionSearch?: unknown
    nccSearchEnabled?: unknown
  }): AppConfig {
    const current = this.get()
    const engine: SearchEngineId = isSearchEngineId(input.engine)
      ? input.engine
      : current.searchEngine
    const custom =
      typeof input.custom === 'string' ? input.custom.trim().slice(0, 2048) : current.searchEngineCustom
    const useOnionSearch =
      typeof input.useOnionSearch === 'boolean' ? input.useOnionSearch : current.useOnionSearch
    const nccSearchEnabled =
      typeof input.nccSearchEnabled === 'boolean' ? input.nccSearchEnabled : current.nccSearchEnabled
    this.config = { ...current, searchEngine: engine, searchEngineCustom: custom, useOnionSearch, nccSearchEnabled }
    this.write()
    return this.get()
  }

  /** Merge a partial appearance update, normalising every field against the defaults. */
  setAppearance(input: unknown): AppConfig {
    const current = this.get()
    const patch = input && typeof input === 'object' ? input : {}
    const appearance: AppearanceConfig = normalizeAppearance({ ...current.appearance, ...patch })
    this.config = { ...current, appearance }
    this.write()
    return this.get()
  }

  setPasswordConfig(input: unknown): AppConfig {
    const current = this.get()
    const patch = input && typeof input === 'object' ? input : {}
    const passwords: PasswordConfig = normalizePasswordConfig({ ...current.passwords, ...patch })
    this.config = { ...current, passwords }
    this.write()
    return this.get()
  }

  addNeverSave(origin: string): AppConfig {
    const value = origin.trim()
    if (!value) return this.get()
    const current = this.get()
    const neverSave = [...new Set([...current.passwords.neverSave, value])].slice(-200)
    this.config = { ...current, passwords: { ...current.passwords, neverSave } }
    this.write()
    return this.get()
  }

  removeNeverSave(origin: string): AppConfig {
    const current = this.get()
    const neverSave = current.passwords.neverSave.filter((entry) => entry !== origin)
    this.config = { ...current, passwords: { ...current.passwords, neverSave } }
    this.write()
    return this.get()
  }

  private read(): AppConfig {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AppConfig>
        return {
          relays: normalizeRelayEntries(parsed.relays ?? defaultRelays()),
          gossip: parsed.gossip !== false,
          anchorRequired: parsed.anchorRequired === true,
          externalAddressChecks:
            parsed.externalAddressChecks === 'always' || parsed.externalAddressChecks === 'never'
              ? parsed.externalAddressChecks
              : 'ask',
          preferTor: parsed.preferTor === true,
          ephemeralSigner: parsed.ephemeralSigner === true,
          torMode: parsed.torMode === 'local' ? 'local' : 'auto',
          torSocks:
            typeof parsed.torSocks === 'string' && parsed.torSocks.trim()
              ? parsed.torSocks.trim()
              : DEFAULT_TOR_SOCKS,
          httpsMode:
            parsed.httpsMode === 'off' || parsed.httpsMode === 'only'
              ? parsed.httpsMode
              : DEFAULT_HTTPS_MODE,
          protection: normalizeProtection(parsed.protection),
          warnInsecure: parsed.warnInsecure === true,
          httpExceptions: Array.isArray(parsed.httpExceptions)
            ? parsed.httpExceptions
                .filter((entry): entry is string => typeof entry === 'string')
                .slice(-200)
            : [],
          searchEngine: isSearchEngineId(parsed.searchEngine)
            ? parsed.searchEngine
            : DEFAULT_SEARCH_ENGINE,
          searchEngineCustom:
            typeof parsed.searchEngineCustom === 'string'
              ? parsed.searchEngineCustom.trim().slice(0, 2048)
              : '',
          useOnionSearch: parsed.useOnionSearch !== false,
          nccSearchEnabled: parsed.nccSearchEnabled === true,
          appearance: normalizeAppearance(parsed.appearance),
          passwords: normalizePasswordConfig(parsed.passwords)
        }
      }
    } catch (error) {
      console.warn('[config] could not read config, using defaults:', error)
    }
    return {
      relays: defaultRelays().map((url) => ({ url })),
      gossip: true,
      anchorRequired: false,
      externalAddressChecks: 'ask',
      preferTor: false,
      ephemeralSigner: false,
      torMode: 'auto',
      torSocks: DEFAULT_TOR_SOCKS,
      httpsMode: DEFAULT_HTTPS_MODE,
      protection: { ...DEFAULT_PROTECTION },
      warnInsecure: false,
      httpExceptions: [],
      searchEngine: DEFAULT_SEARCH_ENGINE,
      searchEngineCustom: '',
      useOnionSearch: true,
      nccSearchEnabled: false,
      appearance: { ...DEFAULT_APPEARANCE },
      passwords: { ...DEFAULT_PASSWORD_CONFIG }
    }
  }

  private write(): void {
    if (!this.config) return
    const path = this.path
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }
}
