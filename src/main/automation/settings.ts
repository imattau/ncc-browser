import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface SettingsFile {
  enabled: boolean
  token: string
}

/**
 * Agent-control preferences, kept apart from the main config so the feature is
 * self-contained. The token is stable across restarts so a client only connects once;
 * the file is user-only (0600).
 */
export class AutomationSettings {
  private data: SettingsFile | null = null

  constructor(private readonly filePath: string) {}

  get enabled(): boolean {
    return this.load().enabled
  }

  get token(): string {
    return this.load().token
  }

  setEnabled(value: boolean): void {
    this.load().enabled = value
    this.save()
  }

  regenerateToken(): string {
    this.load().token = newToken()
    this.save()
    return this.token
  }

  private load(): SettingsFile {
    if (this.data) return this.data
    let parsed: Partial<SettingsFile> = {}
    try {
      if (existsSync(this.filePath)) parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      parsed = {}
    }
    const token =
      typeof parsed.token === 'string' && /^[0-9a-f]{64}$/.test(parsed.token)
        ? parsed.token
        : newToken()
    this.data = { enabled: parsed.enabled === true, token }
    if (token !== parsed.token) this.save()
    return this.data
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp`
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(temp, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Best effort where POSIX modes do not exist.
    }
  }
}

function newToken(): string {
  return randomBytes(32).toString('hex')
}
