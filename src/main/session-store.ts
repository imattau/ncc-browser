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

export interface SavedWindowSession {
  tabs: SavedTab[]
  activeIndex: number
  window: SavedWindow
}

export interface SavedSession extends SavedWindowSession {
  version: 1
  savedAt: number
  windows?: SavedWindowSession[]
}

const FILE_VERSION = 1
const MAX_TABS = 50

function validUrl(url: unknown): string {
  if (typeof url !== 'string') return ''
  const value = url.trim()
  if (!value) return ''
  if (value.length > 4096) return ''
  return /^(ncc:\/\/|nsite:\/\/|https?:\/\/)/i.test(value) ? value : ''
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
      if (parsed.version !== FILE_VERSION || (!Array.isArray(parsed.tabs) && !Array.isArray(parsed.windows))) return null

      if (Array.isArray(parsed.windows)) {
        const windows = [parseWindowSession(parsed), ...parsed.windows.slice(0, 19).map((entry) => parseWindowSession(entry))]
          .filter((entry): entry is SavedWindowSession => Boolean(entry))
        return windows.length ? { version: FILE_VERSION, ...windows[0], windows: windows.slice(1), savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 } : null
      }

      const legacy = parseWindowSession(parsed)
      return legacy ? { version: FILE_VERSION, ...legacy, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 } : null
    } catch (error) {
      console.warn('[session] ignoring unreadable session:', error)
      return null
    }
  }

  save(session: Omit<SavedSession, 'version' | 'savedAt'>): void {
    const primary = normalizeWindowSession(session)
    const windows = (session.windows ?? []).slice(0, 19).map(normalizeWindowSession)
    const payload: SavedSession = {
      version: FILE_VERSION,
      ...primary,
      windows,
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

  /**
   * Persist every open window. An empty list is ignored: the shell also calls this
   * from its `closed` handler, and on the quit path that must not replace the tabs
   * the `close` handler just flushed.
   */
  saveWindows(sessions: SavedWindowSession[]): void {
    if (sessions.length === 0) return
    const [primary, ...windows] = sessions
    this.save({ ...primary, windows })
  }
}

function parseWindowSession(value: unknown): SavedWindowSession | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Partial<SavedSession>).tabs)) return null
  const parsed = value as Partial<SavedSession>
  const tabs: SavedTab[] = parsed.tabs!.slice(0, MAX_TABS).map((tab) => ({ url: validUrl((tab as Partial<SavedTab> | null)?.url) }))
  if (!tabs.length) return null
  const window = (parsed.window ?? {}) as Partial<SavedWindow>
  return {
    tabs,
    activeIndex: finite(parsed.activeIndex, 0, tabs.length - 1, 0),
    window: {
      width: finite(window.width, 760, 10_000, 1280),
      height: finite(window.height, 480, 10_000, 860),
      x: typeof window.x === 'number' && Number.isFinite(window.x) ? Math.round(window.x) : undefined,
      y: typeof window.y === 'number' && Number.isFinite(window.y) ? Math.round(window.y) : undefined,
      maximized: window.maximized === true
    }
  }
}

function normalizeWindowSession(session: SavedWindowSession): SavedWindowSession {
  const tabs = session.tabs.slice(0, MAX_TABS).map((tab) => ({ url: validUrl(tab.url) }))
  return {
    tabs,
    activeIndex: Math.max(0, Math.min(session.activeIndex, Math.max(0, tabs.length - 1))),
    window: session.window
  }
}
