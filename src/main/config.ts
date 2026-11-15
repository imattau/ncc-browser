import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeRelays, defaultRelays } from '@shared/relays'
import { DEFAULT_TOR_SOCKS, type AppConfig, type TorMode } from '@shared/types'

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
    return [...this.get().relays]
  }

  setRelays(input: unknown): AppConfig {
    const relays = normalizeRelays(input)
    this.config = { ...this.get(), relays }
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

  setPreferTor(value: unknown): AppConfig {
    this.config = { ...this.get(), preferTor: value === true }
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

  private read(): AppConfig {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AppConfig>
        return {
          relays: normalizeRelays(parsed.relays ?? defaultRelays()),
          gossip: parsed.gossip !== false,
          anchorRequired: parsed.anchorRequired === true,
          preferTor: parsed.preferTor === true,
          torMode: parsed.torMode === 'local' ? 'local' : 'auto',
          torSocks:
            typeof parsed.torSocks === 'string' && parsed.torSocks.trim()
              ? parsed.torSocks.trim()
              : DEFAULT_TOR_SOCKS
        }
      }
    } catch (error) {
      console.warn('[config] could not read config, using defaults:', error)
    }
    return {
      relays: defaultRelays(),
      gossip: true,
      anchorRequired: false,
      preferTor: false,
      torMode: 'auto',
      torSocks: DEFAULT_TOR_SOCKS
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
