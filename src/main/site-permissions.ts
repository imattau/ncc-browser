import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dialog, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { TabKind } from '@shared/types'

interface SavedSitePermission {
  origin: string
  permission: string
  allowed: boolean
  updatedAt: number
}

interface SitePermissionFile {
  version: 1
  decisions: SavedSitePermission[]
}

/** Persistent permission choices for normal tabs; private and Tor grants stay in memory. */
export class SitePermissionStore {
  private readonly decisions = new Map<string, SavedSitePermission>()
  private loaded = false

  constructor(private readonly filePath: string, private readonly maxEntries = 500) {}

  get(origin: string, permission: string): boolean | undefined {
    this.load()
    return this.decisions.get(permissionKey(origin, permission))?.allowed
  }

  set(origin: string, permission: string, allowed: boolean): void {
    this.load()
    this.decisions.set(permissionKey(origin, permission), {
      origin,
      permission,
      allowed,
      updatedAt: Date.now()
    })
    this.prune()
    this.flush()
  }

  hasOrigin(origin: string): boolean {
    this.load()
    return [...this.decisions.values()].some((decision) => decision.origin === origin)
  }

  revokeOrigin(origin: string): boolean {
    this.load()
    let changed = false
    for (const [key, decision] of this.decisions) {
      if (decision.origin === origin) {
        this.decisions.delete(key)
        changed = true
      }
    }
    if (changed) this.flush()
    return changed
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SitePermissionFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.decisions)) return
      for (const entry of parsed.decisions) {
        if (
          entry && typeof entry.origin === 'string' && typeof entry.permission === 'string' &&
          typeof entry.allowed === 'boolean' && typeof entry.updatedAt === 'number'
        ) {
          this.decisions.set(permissionKey(entry.origin, entry.permission), entry)
        }
      }
    } catch (error) {
      console.warn('[site-permissions] ignoring unreadable permission file:', error)
    }
  }

  private prune(): void {
    if (this.decisions.size <= this.maxEntries) return
    const oldest = [...this.decisions.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, this.decisions.size - this.maxEntries)
    for (const [key] of oldest) this.decisions.delete(key)
  }

  private flush(): void {
    const payload: SitePermissionFile = { version: 1, decisions: [...this.decisions.values()] }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.filePath)
    } catch (error) {
      console.warn('[site-permissions] could not write permission file:', error)
    }
  }
}

/** Camera access is limited to the browser's trusted shell renderer for QR scanning. */
export function installShellCameraPermission(session: Session, getShellContents: () => WebContents, rendererUrl?: string): void {
  const shellOrigin = (value: string): string | null => {
    try {
      const url = new URL(value)
      return url.protocol === 'file:' ? 'file://' : url.origin
    } catch { return null }
  }
  const trustedOrigins = new Set(['file://'])
  if (rendererUrl) {
    const origin = shellOrigin(rendererUrl)
    if (origin) trustedOrigins.add(origin)
  }
  const isTrustedShell = (contents: WebContents | null, url: string): boolean => {
    if (!contents || contents.isDestroyed()) return false
    const shellContents = getShellContents()
    return !shellContents.isDestroyed() && contents.id === shellContents.id && trustedOrigins.has(shellOrigin(url) ?? '')
  }

  session.setPermissionCheckHandler((contents, permission, origin) =>
    permission === 'media' && isTrustedShell(contents, origin)
  )
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || contents.getURL()
    const hasVideoRequest = 'mediaTypes' in details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video')
    callback(permission === 'media' && hasVideoRequest && isTrustedShell(contents, requestingUrl))
  })
}

/** Normal-tab choices can persist; private/Tor decisions vanish with their session. */
export function installSitePermissionPrompts(
  sessions: Array<{ session: Session; kind: TabKind }>,
  getWindow: () => BrowserWindow,
  saved: SitePermissionStore
): void {
  for (const { session, kind } of sessions) {
    const decisions = new Map<string, boolean>()
    session.setPermissionCheckHandler((_contents, permission, rawOrigin) => {
      const origin = permissionOrigin(rawOrigin)
      if (!origin) return false
      const key = permissionKey(origin, permission)
      const sessionDecision = decisions.get(key)
      if (sessionDecision !== undefined) return sessionDecision
      return kind === 'normal' && saved.get(origin, permission) === true
    })
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const raw = details.requestingUrl || contents.getURL()
      const origin = permissionOrigin(raw)
      if (!origin) { callback(false); return }
      const key = permissionKey(origin, permission)
      const remembered = decisions.get(key)
      if (remembered !== undefined) { callback(remembered); return }

      const persisted = kind === 'normal' ? saved.get(origin, permission) : undefined
      if (persisted !== undefined) {
        decisions.set(key, persisted)
        callback(persisted)
        return
      }

      const persistentChoice = kind === 'normal'
      const buttons = persistentChoice
        ? ['Always allow', 'Allow for this session', 'Block for this session', 'Always block']
        : ['Allow for this session', 'Block']
      void dialog.showMessageBox(getWindow(), {
        type: 'question',
        buttons,
        defaultId: persistentChoice ? 2 : 1,
        cancelId: persistentChoice ? 2 : 1,
        title: 'Site permission',
        message: `${origin} wants to use ${permission.replaceAll('-', ' ')}.`,
        detail: persistentChoice
          ? 'Choose an option to remember the decision for this site or this session.'
          : 'This decision is remembered for this private or Tor session only.'
      }).then(({ response }) => {
        const allowed = persistentChoice ? response === 0 || response === 1 : response === 0
        decisions.set(key, allowed)
        if (persistentChoice && (response === 0 || response === 3)) {
          saved.set(origin, permission, allowed)
        }
        callback(allowed)
      }).catch(() => callback(false))
    })
  }
}

/** Electron can report opaque custom-scheme origins as "null"; key those by scheme and host. */
export function permissionOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.origin !== 'null') return url.origin
    if (!url.hostname) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function permissionKey(origin: string, permission: string): string {
  return `${origin}|${permission}`
}
