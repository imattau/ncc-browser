import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeRelays, defaultRelays } from '@shared/relays'
import type { AppConfig } from '@shared/types'

/**
 * Tiny JSON settings store in `userData`. Deliberately not a dependency: the only
 * setting in v0.1 is the relay list.
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

  private read(): AppConfig {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AppConfig>
        return {
          relays: normalizeRelays(parsed.relays ?? defaultRelays()),
          gossip: parsed.gossip !== false
        }
      }
    } catch (error) {
      console.warn('[config] could not read config, using defaults:', error)
    }
    return { relays: defaultRelays(), gossip: true }
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
