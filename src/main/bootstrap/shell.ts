import { app } from 'electron'
import { join } from 'node:path'
import type { TabKind } from '@shared/types'
import { BookmarkStore } from '../bookmarks'
import { HistoryStore } from '../history'
import { OmniboxService } from '../omnibox'
import { toHexPubkey } from '../ncc/resolver'
import { partitionFor } from '../sessions'
import { SessionStore, type SavedSession } from '../session-store'
import { BrowserShell, browserShells, type ShellDeps } from '../shell'
import {
  installShellCameraPermission,
  installSitePermissionPrompts
} from '../site-permissions'
import type { BrowserStack } from './browser'
import type { Foundation } from './foundation'
import type { Runtime } from './runtime'

export interface ShellStack {
  shell: BrowserShell
  bookmarks: BookmarkStore
  history: HistoryStore
  omnibox: OmniboxService
  sessionStore: SessionStore
  initialSession: SavedSession | null
  createWindow: (saved?: SavedSession | null, bounds?: { x: number; y: number }) => BrowserShell
}

/** The chrome window and the stores that only it uses. */
export function createShellStack(
  runtime: Runtime,
  foundation: Foundation,
  browser: BrowserStack
): ShellStack {
  const bookmarks = new BookmarkStore(join(app.getPath('userData'), 'bookmarks.json'))
  const history = new HistoryStore(join(app.getPath('userData'), 'history.json'))
  const omnibox = new OmniboxService({
    history,
    bookmarks,
    config: () => foundation.config.get()
  })
  const sessionStore = new SessionStore(
    join(app.getPath('userData'), 'session.json')
  )
  const initialSession = sessionStore.load()

  const baseDeps: Omit<ShellDeps, 'initialSession' | 'initialBounds' | 'deferInitialTabs'> = {
    preloadPath: join(__dirname, '../preload/index.js'),
    contentPreloadPath: join(__dirname, '../preload/content.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    activeServices: browser.activeServices,
    httpPolicies: browser.httpPolicies,
    omnibox,
    partitionFor,
    releaseSession: browser.releaseSession,
    bookmarks,
    sessionStore,
    transport: browser.transport,
    tor: browser.tor,
    torGuard: browser.torGuard,
    protectionScriptForUrl: (url: string, kind: TabKind) =>
      foundation.protection.cosmeticScript(url, kind),
    health: foundation.health,
    preferTor: () => foundation.config.get().preferTor,
    appearance: () => foundation.config.get().appearance,
    onContentWebContents: (contents) => {
      // Remote content must never be able to keep the window from closing.
      contents.on('will-prevent-unload', (event) => event.preventDefault())
    },
    extensionContextItems: (url) => runtime.extensions?.contextMenuItems(url) ?? [],
    invalidateSite: browser.invalidateSite,
    onHostedResolved: (activity) => {
      if (!activity.locator?.encrypted) return
      const owner = toHexPubkey(activity.pubkey)
      if (!owner) return
      foundation.hosting.recordReceived({
        owner,
        dTag: activity.locator.dTag,
        expiresAt: activity.locator.expiresAt,
        ...(activity.locator.notes ? { title: activity.locator.notes } : {}),
        encrypted: true
      })
    },
    createWindow: (bounds) => createWindow(null, bounds),
    onSessionChanged: () =>
      sessionStore.saveWindows(browserShells().map((entry) => entry.sessionSnapshot()))
  }

  let createWindow: ShellStack['createWindow']
  const shell = new BrowserShell({ ...baseDeps, initialSession })
  createWindow = (saved, bounds) => {
    const child = new BrowserShell({
      ...baseDeps,
      initialSession: saved,
      initialBounds: bounds,
      deferInitialTabs: !saved
    })
    child.loadChrome()
    return child
  }

  runtime.shell = shell
  runtime.createFallbackShell = () => createWindow(null)

  for (const saved of initialSession?.windows ?? []) {
    createWindow({ version: 1, ...saved, savedAt: initialSession?.savedAt ?? 0 })
  }

  installShellCameraPermission(
    shell.window.webContents.session,
    () => shell.window.webContents,
    process.env.ELECTRON_RENDERER_URL
  )
  installSitePermissionPrompts(
    [
      { session: browser.content.normal, kind: 'normal' },
      { session: browser.content.private, kind: 'private' },
      { session: browser.content.tor, kind: 'tor' }
    ],
    () => shell.window,
    foundation.sitePermissions
  )

  return { shell, bookmarks, history, omnibox, sessionStore, initialSession, createWindow }
}
