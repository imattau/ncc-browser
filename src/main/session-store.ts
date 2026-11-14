import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SavedTab {
  /** Empty string means a blank tab, which still restores the tab strip layout. */
  url: string
}

export interface SavedWindow {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export interface SavedSession {
  version: 1
  tabs: SavedTab[]
  activeIndex: number
  window: SavedWindow
  savedAt: number
}

const FILE_VERSION = 1
const MAX_TABS = 50

function validUrl(url: unknown): string {
  if (typeof url !== 'string') return ''
  const value = url.trim()
  if (!value) return ''
  if (value.length > 4096) return ''
  return /^(ncc:\/\/|https?:\/\/)/i.test(value) ? value : ''
}

function finite(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Tabs and window geometry for the next launch. Only addresses are stored; page
 * content, scroll positions and form state deliberately are not.
 */
export class SessionStore {
  constructor(private readonly filePath: string) {}

  load(): SavedSession | null {
    try {
      if (!existsSync(this.filePath)) return null
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SavedSession>
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.tabs)) return null

      const tabs: SavedTab[] = parsed.tabs
        .slice(0, MAX_TABS)
        .map((tab) => ({ url: validUrl((tab as Partial<SavedTab> | null)?.url) }))
      if (tabs.length === 0) return null

      const window = (parsed.window ?? {}) as Partial<SavedWindow>
      const maximized = window.maximized === true
      return {
        version: FILE_VERSION,
        tabs,
        activeIndex: finite(parsed.activeIndex, 0, tabs.length - 1, 0),
        window: {
          width: finite(window.width, 760, 10_000, 1280),
          height: finite(window.height, 480, 10_000, 860),
          x: typeof window.x === 'number' && Number.isFinite(window.x) ? Math.round(window.x) : undefined,
          y: typeof window.y === 'number' && Number.isFinite(window.y) ? Math.round(window.y) : undefined,
          maximized
        },
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
      }
    } catch (error) {
      console.warn('[session] ignoring unreadable session:', error)
      return null
    }
  }

  save(session: Omit<SavedSession, 'version' | 'savedAt'>): void {
    const payload: SavedSession = {
      version: FILE_VERSION,
      tabs: session.tabs.slice(0, MAX_TABS).map((tab) => ({ url: validUrl(tab.url) })),
      activeIndex: Math.max(0, Math.min(session.activeIndex, Math.max(0, session.tabs.length - 1))),
      window: session.window,
      savedAt: Date.now()
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      console.warn('[session] could not write session:', error)
    }
  }
}
