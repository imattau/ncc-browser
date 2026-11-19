import {
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  clipboard,
  screen,
  shell,
  type Input,
  type WebContents
} from 'electron'
import { parseNccAddress, toDisplayUrl, toInternalUrl, type NccAddress } from '@shared/ncc-url'
import {
  buildNsiteUrl,
  parseNsiteAddress,
  toNsiteDisplayUrl,
  type NsiteAddress
} from '@shared/nsite-url'
import type { NsiteActivity } from './nsite/protocol'
import { BANNER_HEIGHT, CHROME_HEIGHT } from '@shared/layout'
import type { CommandId } from '@shared/commands'
import { reorderTabs } from '@shared/tabs'
import { appearanceBootArgument } from '@shared/appearance'
import { installChromeContextMenu, installContentContextMenu } from './context-menu'
import { commandForInput } from './shortcuts'
import { fetchFavicon } from './favicon'
import { renderErrorPage } from './error-page'
import { windowBackground } from './appearance'
import type { BookmarkStore } from './bookmarks'
import type { SavedSession, SavedWindow, SessionStore } from './session-store'
import type { ExtensionPage } from '@shared/extensions'
import type {
  AppearanceConfig,
  AppConfig,
  Bookmark,
  DownloadNotice,
  NavState,
  OmniboxSuggestion,
  PageMode,
  PasswordPage,
  SecurityInfo,
  TabHistory,
  TabKind,
  TabSummary
} from '@shared/types'
import type { ProtocolActivity } from './protocol'
import type { EndpointHealth } from './ncc/health'
import type { TransportPolicy } from './ncc/transport'
import type { OmniboxService, OmniboxTab } from './omnibox'
import {
  isHttpExemptUrl,
  shouldUpgradeHttp,
  upgradeToHttps,
  webHttpKey,
  type HttpPolicy
} from './security'
import { isAllowedTorUrl, isOnionHost, type TorGuard } from './tor/guard'
import type { TorManager } from './tor/manager'

/**
 * Where the NCC-05 specification lives. Opened as a tab in the current tab's transport
 * mode: the browser can render it, and a Tor tab must not leak the request to the
 * desktop browser.
 */
const NCC_SPEC_URL =
  'https://github.com/imattau/nostr-community-conventions/blob/master/ncc-05/README.md'

export interface ShellDeps {
  preloadPath: string
  contentPreloadPath: string
  rendererUrl?: string
  rendererFile: string
  activeServices: Record<TabKind, Map<string, string>>
  httpPolicies: Record<TabKind, HttpPolicy>
  omnibox: OmniboxService
  partitionFor: (kind: TabKind) => string
  releaseSession: (kind: TabKind) => void
  bookmarks: BookmarkStore
  sessionStore: SessionStore
  initialSession?: SavedSession | null
  transport: TransportPolicy
  tor: TorManager
  torGuard: TorGuard
  protectionScriptForUrl?: (url: string, kind: TabKind) => string
  health: EndpointHealth
  preferTor: () => boolean
  appearance: () => AppearanceConfig
  onContentWebContents?: (contents: WebContents) => void
  extensionContextItems?: (url: string) => Array<{ label: string; click: () => void }>
  /** Drop a cached NCC locator before a forced reload. */
  invalidateSite?: (url: string, kind: TabKind) => void
}

interface Tab {
  id: string
  kind: TabKind
  view: WebContentsView
  mode: PageMode
  displayUrl: string
  pubkey: string | null
  service: string | null
  security: SecurityInfo | null
  failure: { code: string; message: string } | null
  tor: { onionAvailable: boolean; active: boolean }
  pendingHttp: { original: string; key: string; httpsUrl: string } | null
  programmatic: boolean
  loading: boolean
  favicon: string | null
  audible: boolean
  muted: boolean
}

const CONTENT_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
  safeDialogs: true
} as const

/**
 * Window layout and tab management: a trusted local chrome renderer on top, and one
 * sandboxed WebContentsView per tab below it. All tabs share a single content session
 * so an npub keeps one origin (and one cookie jar) across tabs; requests are attributed
 * to the right service through the referrer, not through per-tab origins.
 */
export class BrowserShell {
  readonly window: BrowserWindow
  private readonly deps: ShellDeps
  private readonly tabs: Tab[] = []
  private activeId: string | null = null
  private nextTabId = 1
  private readonly overlays = new Set<string>()
  private saveTimer: NodeJS.Timeout | null = null
  private pendingInsecure: {
    tabId: string
    url: string
    key: string
    previous: string
  } | null = null

  constructor(deps: ShellDeps) {
    this.deps = deps
    const savedWindow = deps.initialSession?.window
    const bounds = restoreWindowBounds(savedWindow)

    this.window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x !== undefined && bounds.y !== undefined
        ? { x: bounds.x, y: bounds.y }
        : {}),
      minWidth: 760,
      minHeight: 480,
      // The tab strip is the title bar: custom drag region and window controls.
      frame: false,
      backgroundColor: windowBackground(),
      show: false,
      title: 'Nostr Navigator',
      webPreferences: {
        preload: deps.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // Lets the preload hand the renderer the appearance before React mounts.
        additionalArguments: [appearanceBootArgument(deps.appearance())]
      }
    })

    this.wireWindow()
    installChromeContextMenu(this.window.webContents, () => this.window)
    this.window.webContents.on('before-input-event', (event, input) =>
      this.handleInput(event, input)
    )
    this.window.on('blur', () => this.sendChrome('ncc:close-menu'))
    // A chrome reload (dev HMR, devtools) loses which overlay owned the surface.
    this.window.webContents.on('did-finish-load', () => this.clearOverlays())
    this.restoreTabs(deps.initialSession)
    if (savedWindow?.maximized) this.window.maximize()
    this.window.once('ready-to-show', () => this.window.show())
  }

  loadChrome(): void {
    if (this.deps.rendererUrl) {
      void this.window.loadURL(this.deps.rendererUrl)
    } else {
      void this.window.loadFile(this.deps.rendererFile)
    }
  }

  /** Push an updated config to the chrome renderer, e.g. after a relay rotated. */
  sendConfig(config: AppConfig): void {
    this.sendChrome('ncc:config', config)
  }

  /** Public chrome notification used by services that live outside the shell. */
  sendToChrome(channel: string, payload?: unknown): boolean {
    return this.sendChrome(channel, payload)
  }

  /** Open a known settings section from the separately permissioned MCP surface. */
  openAutomationSettings(section: 'general' | 'identity' | 'passwords'): void {
    this.window.focus()
    this.sendChrome('ncc:open-settings', { section })
  }

  /** Main-process view of one tab, for the password manager. */
  pageForTab(tabId: string): PasswordPage | null {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (!tab) return null
    const contents = tab.view.webContents
    return {
      tabId: tab.id,
      kind: tab.kind,
      mode: tab.mode,
      url: contents.isDestroyed() ? tab.displayUrl : contents.getURL() || tab.displayUrl,
      displayUrl: tab.displayUrl,
      title: tabTitle(tab),
      security: tab.security
    }
  }

  activePage(): PasswordPage | null {
    return this.activeId ? this.pageForTab(this.activeId) : null
  }

  /** Live contents for the active tab; used for in-page site-data clearing. */
  activeContents(): WebContents | null {
    const tab = this.activeId ? this.tabs.find((entry) => entry.id === this.activeId) : null
    const contents = tab?.view.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  /** Live contents for automation. Private and Tor tabs are never handed out. */
  automationContents(tabId: string): WebContents | null {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (!tab || tab.kind !== 'normal') return null
    const contents = tab.view.webContents
    return contents.isDestroyed() ? null : contents
  }

  tabIdForContents(webContentsId: number): string | null {
    const tab = this.tabs.find(
      (entry) => !entry.view.webContents.isDestroyed() && entry.view.webContents.id === webContentsId
    )
    return tab?.id ?? null
  }

  /** Chrome-style tab list for the extension runtime. */
  extensionPages(): ExtensionPage[] {
    return this.tabs.map((tab) => {
      const contents = tab.view.webContents
      return {
        id: contents.isDestroyed() ? -1 : contents.id,
        tabId: tab.id,
        kind: tab.kind,
        url:
          contents.isDestroyed() || !contents.getURL()
            ? tab.displayUrl
            : contents.getURL(),
        title: tabTitle(tab),
        active: tab.id === this.activeId,
        incognito: tab.kind !== 'normal'
      }
    })
  }

  navigateTab(tabId: string, input: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (tab) void this.navigateInTab(tab, input)
  }

  sendToContent(tabId: string, channel: string, payload: unknown): boolean {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return false
    tab.view.webContents.send(channel, payload)
    return true
  }

  /** Match the native window background to the resolved theme. */
  applyAppearance(): void {
    if (!this.window.isDestroyed()) this.window.setBackgroundColor(windowBackground())
  }

  getState(): NavState {
    const active = this.activeTab()
    const contents = active?.view.webContents
    const history = contents?.navigationHistory

    const tabs: TabSummary[] = this.tabs.map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tabTitle(tab),
      url: tab.displayUrl,
      loading: tab.loading,
      favicon: tab.favicon,
      audible: tab.audible,
      muted: tab.muted
    }))

    return {
      mode: active?.mode ?? 'blank',
      displayUrl: active?.displayUrl ?? '',
      url: contents && !contents.isDestroyed() ? contents.getURL() : '',
      title: active ? tabTitle(active) : '',
      loading: active?.loading ?? false,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
      security: active?.security ?? null,
      failure: active?.failure ?? null,
      tor: {
        preferTor: this.deps.preferTor(),
        onionAvailable: active?.tor.onionAvailable ?? false,
        active: active?.tor.active ?? false,
        tabTor: active?.kind === 'tor'
      },
      tabKind: active?.kind ?? 'normal',
      banner: this.bannerFor(active),
      insecurePrompt: this.insecurePromptFor(active),
      tabs,
      activeTabId: this.activeId,
      windowMaximized: this.window.isMaximized()
    }
  }

  newTab(input?: string, kind: TabKind = 'normal'): string {
    const tab = this.createTab(kind)
    this.activateTab(tab.id)
    if (input) void this.navigateInTab(tab, input)
    return tab.id
  }

  newPrivateTab(input?: string): string {
    return this.newTab(input, 'private')
  }

  newTorTab(input?: string): string {
    const tab = this.createTab('tor')
    this.activateTab(tab.id)
    void this.deps.tor
      .ensureReady()
      .then(() => this.syncState())
      .catch(() => this.syncState())
    if (input) void this.navigateInTab(tab, input)
    return tab.id
  }

  closeTab(id?: string): void {
    const target = id ? this.tabs.find((tab) => tab.id === id) : this.activeTab()
    if (!target) return
    if (this.pendingInsecure?.tabId === target.id) this.cancelInsecurePrompt()

    const index = this.tabs.indexOf(target)
    this.tabs.splice(index, 1)

    try {
      target.view.webContents.stop()
      this.deps.torGuard.delete(target.view.webContents.id)
      this.window.contentView.removeChildView(target.view)
      target.view.webContents.close()
    } catch (error) {
      console.warn('[shell] could not close tab:', error)
    }

    if (this.activeId === target.id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null
      this.activeId = next?.id ?? null
      if (next) this.showOnly(next.id)
    }

    this.releaseKindIfUnused(target.kind)

    this.scheduleSessionSave()
    this.syncState()
  }

  /** Move a tab to an index measured before the move (drop position in the strip). */
  moveTab(id: string, toIndex: number): void {
    const next = reorderTabs(this.tabs, id, toIndex)
    if (next.every((tab, index) => tab === this.tabs[index])) return
    this.tabs.splice(0, this.tabs.length, ...next)
    this.scheduleSessionSave()
    this.syncState()
  }

  duplicateTab(id?: string): string | null {
    const source = id ? this.tabs.find((tab) => tab.id === id) : this.activeTab()
    if (!source) return null
    const tab = this.createTab(source.kind)
    this.activateTab(tab.id)
    if (source.mode !== 'blank' && source.displayUrl) {
      void this.navigateInTab(tab, source.displayUrl)
    }
    return tab.id
  }

  toggleMute(id?: string): void {
    const tab = id ? this.tabs.find((entry) => entry.id === id) : this.activeTab()
    if (!tab) return
    const contents = tab.view.webContents
    tab.muted = !contents.isAudioMuted()
    contents.setAudioMuted(tab.muted)
    this.syncState()
  }

  closeOtherTabs(id?: string): void {
    const keep = id ? this.tabs.find((tab) => tab.id === id) : this.activeTab()
    if (!keep) return
    this.activateTab(keep.id)
    for (const tab of [...this.tabs]) {
      if (tab.id !== keep.id) this.closeTab(tab.id)
    }
  }

  /** Close every tab of one kind, which also releases that kind's session. */
  closeTabsOfKind(kind: TabKind): void {
    for (const tab of [...this.tabs]) {
      if (tab.kind === kind) this.closeTab(tab.id)
    }
  }

  /** The `+` button's menu: the only place a normal tab user meets private and Tor. */
  showNewTabMenu(): void {
    Menu.buildFromTemplate([
      { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => this.newTab() },
      {
        label: 'New private tab',
        accelerator: 'CmdOrCtrl+Shift+N',
        click: () => this.newPrivateTab()
      },
      {
        label: 'New Tor tab',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => this.newTorTab()
      }
    ]).popup({ window: this.window })
  }

  closeTabsToRight(id?: string): void {
    const anchor = id ? this.tabs.find((tab) => tab.id === id) : this.activeTab()
    if (!anchor) return
    const index = this.tabs.indexOf(anchor)
    for (const tab of [...this.tabs.slice(index + 1)]) this.closeTab(tab.id)
  }

  reloadTab(id?: string): void {
    const tab = id ? this.tabs.find((entry) => entry.id === id) : this.activeTab()
    tab?.view.webContents.reload()
  }

  selectTab(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    this.activateTab(id)
  }

  /**
   * Hide all content views while chrome-owned UI needs the whole window: the approval
   * sheet or the hamburger menu. Reasons are reference-counted so one closing does not
   * reveal the page underneath the other.
   */
  setOverlay(reason: string, active: boolean): void {
    const wasHidden = this.overlays.size > 0
    if (active) this.overlays.add(reason)
    else this.overlays.delete(reason)
    const hidden = this.overlays.size > 0
    if (wasHidden === hidden) return

    if (hidden) {
      for (const tab of this.tabs) {
        try {
          tab.view.setVisible(false)
        } catch {
          // View.setVisible fallback: bounds are collapsed on creation.
        }
      }
      return
    }

    const activeTab = this.activeTab()
    if (!activeTab) return
    if (activeTab.mode === 'blank') return
    activeTab.view.setBounds(this.contentBounds())
    try {
      activeTab.view.setVisible(true)
    } catch {
      // Fallback handled by showOnly on the next activation.
    }
  }

  private clearOverlays(): void {
    if (this.overlays.size === 0) return
    this.overlays.clear()
    if (this.activeId) this.showOnly(this.activeId)
  }

  runCommand(command: CommandId): void {
    switch (command) {
      case 'new-tab':
        this.newTab()
        this.focusAddress()
        break
      case 'new-private-tab':
        this.newPrivateTab()
        this.focusAddress()
        break
      case 'new-tor-tab':
        this.newTorTab()
        this.focusAddress()
        break
      case 'close-tab':
        this.closeTab()
        break
      case 'next-tab':
        this.nextTab()
        break
      case 'previous-tab':
        this.previousTab()
        break
      case 'focus-address':
        this.focusAddress()
        break
      case 'back':
        this.back()
        break
      case 'forward':
        this.forward()
        break
      case 'reload':
        this.reload()
        break
      case 'force-reload':
        void this.forceReload()
        break
      case 'stop':
        this.stop()
        break
      case 'zoom-in':
        this.zoomIn()
        break
      case 'zoom-out':
        this.zoomOut()
        break
      case 'zoom-reset':
        this.zoomReset()
        break
      case 'toggle-page-devtools':
        this.togglePageDevTools()
        break
      case 'toggle-browser-devtools':
        this.toggleChromeDevTools()
        break
      case 'toggle-bookmark':
        this.toggleBookmark()
        break
      case 'open-history':
        this.sendChrome('ncc:open-history')
        break
      case 'open-downloads':
        this.sendChrome('ncc:open-downloads')
        break
      case 'open-settings':
        this.sendChrome('ncc:open-settings', { section: 'general' })
        break
      case 'open-identity':
        this.sendChrome('ncc:open-settings', { section: 'identity' })
        break
      case 'open-passwords':
        this.sendChrome('ncc:open-settings', { section: 'passwords' })
        break
      case 'open-spec':
        // Open documentation in a tab, not the desktop browser: history, zoom and the
        // current transport mode all apply, and a Tor tab does not leak to clearnet.
        if (this.activeTab()?.kind === 'tor') this.newTorTab(NCC_SPEC_URL)
        else if (this.activeTab()?.kind === 'private') this.newPrivateTab(NCC_SPEC_URL)
        else this.newTab(NCC_SPEC_URL)
        break
      case 'quit':
        app.quit()
        break
    }
  }

  async navigate(input: string): Promise<void> {
    const tab = this.activeTab() ?? this.createTab()
    this.activateTab(tab.id)
    await this.navigateInTab(tab, input)
  }

  back(): void {
    const history = this.activeTab()?.view.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(): void {
    const history = this.activeTab()?.view.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(): void {
    const tab = this.activeTab()
    if (!tab) {
      this.syncState()
      return
    }
    tab.view.webContents.reload()
  }

  stop(): void {
    this.activeTab()?.view.webContents.stop()
  }

  /** Focus the address bar in the trusted chrome, regardless of page focus. */
  focusAddress(): void {
    if (this.window.isDestroyed()) return
    this.window.focus()
    this.window.webContents.send('ncc:focus-address')
  }

  nextTab(): void {
    this.cycleTab(1)
  }

  previousTab(): void {
    this.cycleTab(-1)
  }

  async forceReload(): Promise<void> {
    const tab = this.activeTab()
    if (!tab) return
    const contents = tab.view.webContents
    // Chromium keeps custom-scheme documents in the network cache even for
    // reloadIgnoringCache. Clear the content session first so a forced refresh
    // actually re-enters the ncc:// handler and fetches the current document.
    try {
      await contents.session.clearCache()
    } catch (error) {
      console.warn('[shell] could not clear the content cache:', error)
    }
    // A forced reload is the user saying "this endpoint is wrong": drop the cached
    // locator too, so the handler asks relays instead of replaying the same record.
    if ((tab.mode === 'ncc' || tab.mode === 'nsite') && tab.displayUrl) {
      this.deps.invalidateSite?.(tab.displayUrl, tab.kind)
    }
    if (contents.isDestroyed()) return
    contents.reloadIgnoringCache()
  }

  zoomIn(): void {
    this.adjustZoom(0.1)
  }

  zoomOut(): void {
    this.adjustZoom(-0.1)
  }

  zoomReset(): void {
    this.activeTab()?.view.webContents.setZoomFactor(1)
  }

  togglePageDevTools(): void {
    this.activeTab()?.view.webContents.toggleDevTools()
  }

  toggleChromeDevTools(): void {
    this.window.webContents.toggleDevTools()
  }

  minimizeWindow(): void {
    this.window.minimize()
  }

  toggleMaximizeWindow(): void {
    if (this.window.isMaximized()) this.window.unmaximize()
    else this.window.maximize()
  }

  closeWindow(): void {
    this.window.close()
  }

  /** The active tab's history, so the chrome can offer a real jump list. */
  getTabHistory(id?: string): TabHistory {
    const tab = id ? this.tabs.find((entry) => entry.id === id) : this.activeTab()
    if (!tab) return { entries: [], activeIndex: -1 }
    const history = tab.view.webContents.navigationHistory
    const entries = history.getAllEntries().map((entry, index) => ({
      index,
      title: entry.title?.trim() || entry.url,
      url: entry.url
    }))
    return { entries, activeIndex: history.getActiveIndex() }
  }

  goToHistoryIndex(index: number): void {
    const tab = this.activeTab()
    if (!tab) return
    const history = tab.view.webContents.navigationHistory
    const count = history.getAllEntries().length
    if (!Number.isInteger(index) || index < 0 || index >= count) return
    history.goToIndex(index)
  }

  clearHistory(): void {
    this.activeTab()?.view.webContents.navigationHistory.clear()
    this.syncState()
  }

  /** Right-click (or long-press) jump list for the back/forward buttons. */
  showHistoryMenu(direction: 'back' | 'forward'): void {
    const tab = this.activeTab()
    if (!tab) return
    const history = tab.view.webContents.navigationHistory
    const entries = history.getAllEntries()
    const activeIndex = history.getActiveIndex()
    const candidates =
      direction === 'back'
        ? entries.map((entry, index) => ({ entry, index })).filter((item) => item.index < activeIndex).reverse()
        : entries.map((entry, index) => ({ entry, index })).filter((item) => item.index > activeIndex)

    if (candidates.length === 0) return
    Menu.buildFromTemplate(
      candidates.map(({ entry, index }) => ({
        label: historyLabel(entry.title, entry.url),
        click: () => history.goToIndex(index)
      }))
    ).popup({ window: this.window })
  }

  showTabMenu(id: string): void {
    const tab = this.tabs.find((entry) => entry.id === id)
    if (!tab) return
    const index = this.tabs.indexOf(tab)
    const contents = tab.view.webContents

    Menu.buildFromTemplate([
      { label: 'Reload', click: () => contents.reload() },
      { label: 'Duplicate', click: () => void this.duplicateTab(tab.id) },
      {
        label: tab.muted ? 'Unmute tab' : 'Mute tab',
        click: () => this.toggleMute(tab.id)
      },
      { type: 'separator' },
      {
        label: 'Copy address',
        enabled: Boolean(tab.displayUrl),
        click: () => clipboard.writeText(tab.displayUrl)
      },
      { type: 'separator' },
      { label: 'Close tab', click: () => this.closeTab(tab.id) },
      {
        label: 'Close other tabs',
        enabled: this.tabs.length > 1,
        click: () => this.closeOtherTabs(tab.id)
      },
      {
        label: 'Close tabs to the right',
        enabled: index < this.tabs.length - 1,
        click: () => this.closeTabsToRight(tab.id)
      },
      ...(tab.kind === 'normal'
        ? []
        : [
            { type: 'separator' as const },
            {
              label: tab.kind === 'tor' ? 'Close all Tor tabs' : 'Close all private tabs',
              click: () => this.closeTabsOfKind(tab.kind)
            }
          ])
    ]).popup({ window: this.window })
  }

  getBookmarks(): Bookmark[] {
    return this.deps.bookmarks.list()
  }

  toggleBookmark(): Bookmark[] {
    const page = this.getActivePage()
    if (!page) return this.getBookmarks()
    const list = this.deps.bookmarks.toggle(page.url, page.title)
    this.sendChrome('ncc:bookmarks', list)
    return list
  }

  removeBookmark(url: string): Bookmark[] {
    const list = this.deps.bookmarks.remove(url)
    this.sendChrome('ncc:bookmarks', list)
    return list
  }

  getActivePage(): { url: string; title: string } | null {
    const tab = this.activeTab()
    if (!tab || tab.mode === 'blank' || !tab.displayUrl) return null
    return { url: tab.displayUrl, title: tabTitle(tab) }
  }

  /** Address-bar suggestions for the active tab; local sources only. */
  suggest(input: string): OmniboxSuggestion[] {
    const kind = this.activeTab()?.kind ?? 'normal'
    const tabs: OmniboxTab[] = this.tabs
      .filter((tab) => tab.mode !== 'blank' && tab.displayUrl && !tab.view.webContents.isDestroyed())
      .map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        title: tabTitle(tab),
        url: tab.displayUrl
      }))
    return this.deps.omnibox.suggest(input, kind, tabs)
  }

  clearBrowsingHistory(): void {
    this.deps.omnibox.clearHistory()
    this.syncState()
  }

  /** Set by sync: called whenever the set of tabs or their addresses may have changed. */
  onTabsChanged: (() => void) | null = null

  /** Normal user tabs as sync publishes them. App-internal nccsearch is local-only. */
  syncTabs(): { url: string; title: string; lastActive: number }[] {
    const now = Date.now()
    return this.tabs
      .filter((tab) =>
        tab.kind === 'normal' &&
        tab.mode !== 'blank' &&
        tab.displayUrl &&
        !/^nccsearch:\/\//i.test(tab.displayUrl)
      )
      .map((tab) => ({
        url: tab.displayUrl,
        title: tabTitle(tab),
        lastActive: tab.id === this.activeId ? now : 0
      }))
  }

  /** Flush tabs and geometry immediately (quit path). */
  saveSessionNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.window.isDestroyed()) return

    const bounds = this.window.getNormalBounds()
    const normalTabs = this.tabs.filter((tab) => tab.kind === 'normal')
    const savedTabs = normalTabs.length
      ? normalTabs.map((tab) => ({
          url: tab.mode === 'blank' ? '' : tab.displayUrl
        }))
      : [{ url: '' }]
    const activeIndex = Math.max(
      0,
      normalTabs.findIndex((tab) => tab.id === this.activeId)
    )
    this.deps.sessionStore.save({
      tabs: savedTabs,
      activeIndex,
      window: {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: this.window.isMaximized()
      }
    })
  }

  /** Called by the protocol handler for document-level activity only. */
  reportActivity(activity: ProtocolActivity): void {
    const tabs = this.tabs.filter(
      (tab) => tab.pubkey === activity.pubkey && tab.service === activity.service
    )
    if (tabs.length === 0) return

    if (activity.torRedirect) {
      this.redirectToTorTab(tabs.filter((tab) => tab.kind !== 'tor'))
      return
    }

    const onionAvailable = activity.onionAvailable === true
    for (const tab of tabs) {
      const active =
        !activity.failureCode && (tab.kind === 'tor' || activity.viaTor === true)
      tab.tor = { onionAvailable, active }
      if (tab.kind !== 'tor') this.deps.torGuard.set(tab.view.webContents.id, active)
      if (activity.failureCode) {
        tab.failure = { code: activity.failureCode, message: activity.failureCode }
        tab.security = null
      } else {
        tab.failure = null
        tab.security = {
          transport: activity.transport,
          host: activity.endpointHost ?? '',
          pinned: activity.pinned,
          viaTor: tab.kind === 'tor' || activity.viaTor === true,
          onion: activity.viaOnion === true,
          anchor: activity.anchor ?? null,
          locator: activity.locator ?? null
        }
      }
    }
    this.syncState()
  }

  /** State update from the nsite protocol handler. */
  reportNsiteActivity(activity: NsiteActivity): void {
    const tabs = this.tabs.filter(
      (tab) =>
        tab.mode === 'nsite' &&
        tab.pubkey === activity.pubkey &&
        (tab.service ?? null) === activity.site
    )
    if (tabs.length === 0) return

    for (const tab of tabs) {
      if (activity.failureCode) {
        tab.failure = { code: activity.failureCode, message: activity.failureCode }
        tab.security = null
      } else {
        tab.failure = null
        tab.security = {
          transport: 'nsite',
          host: '',
          pinned: false,
          viaTor: tab.kind === 'tor',
          onion: false,
          anchor: null,
          locator: null,
          manifest: activity.manifest ?? null
        }
      }
    }
    this.syncState()
  }

  /** Move a normal or private tab's NCC navigation into a Tor tab. */
  private redirectToTorTab(tabs: Tab[]): void {
    const tab = tabs.find((t) => t.id === this.activeId) ?? tabs[0]
    if (!tab || !tab.displayUrl) return
    const url = tab.displayUrl
    const wc = tab.view.webContents
    this.newTorTab(url)
    // Leave the original tab where it was: back if it has history, else close it.
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else this.closeTab(tab.id)
  }

  /** True when at least one tab for this service is currently served over Tor. */
  isTorService(pubkey: string, service: string): boolean {
    return this.tabs.some(
      (tab) =>
        tab.kind !== 'tor' &&
        tab.pubkey === pubkey &&
        tab.service === service &&
        tab.tor.active
    )
  }

  /**
   * The onion button never routes a normal or private tab through Tor: it opens the
   * page in a Tor tab, the only tab kind that uses Tor connections.
   */
  toggleTor(): void {
    const tab = this.activeTab()
    if (!tab || tab.kind === 'tor' || tab.mode !== 'ncc') return
    if (!tab.tor.onionAvailable || !tab.displayUrl) return
    this.newTorTab(tab.displayUrl)
  }

  /** Apply transport and content-protection changes to every open page. */
  applySecuritySettings(): void {
    for (const tab of this.tabs) {
      tab.view.webContents.reloadIgnoringCache()
    }
    this.syncState()
  }

  /** Clear overrides and reload NCC tabs after the global Tor preference changes. */
  applyTorPreference(): void {
    this.deps.transport.clear()
    this.deps.health.clear()
    for (const tab of this.tabs) {
      if (tab.mode !== 'ncc') continue
      tab.view.webContents.reloadIgnoringCache()
    }
    this.syncState()
  }

  notifyDownload(notice: DownloadNotice): void {
    if (this.window.isDestroyed()) return
    this.window.webContents.send('ncc:download', notice)
  }

  private async navigateInTab(tab: Tab, input: string): Promise<void> {
    const text = input.trim()
    if (!text) return

    this.activateTab(tab.id)

    if (tab.kind === 'tor') {
      tab.loading = true
      this.syncState()
      try {
        await this.deps.tor.ensureReady()
      } catch (error) {
        await this.loadWebError(
          tab,
          text,
          'tor-unavailable',
          error instanceof Error ? error.message : String(error)
        )
        return
      }
    }

    const target = this.deps.omnibox.classify(text, tab.kind)
    if (target.kind === 'invalid') {
      tab.failure = { code: target.code, message: target.message }
      this.syncState()
      return
    }

    if (target.kind === 'web' || target.kind === 'search') {
      await this.openWebUrl(tab, target.url)
      return
    }

    if (target.kind === 'nsite') {
      let nsite: NsiteAddress
      try {
        nsite = parseNsiteAddress(target.url)
      } catch (error) {
        tab.failure = {
          code: 'invalid-address',
          message: error instanceof Error ? error.message : 'Invalid nsite address'
        }
        this.syncState()
        return
      }
      tab.mode = 'nsite'
      tab.pubkey = nsite.pubkey
      tab.service = nsite.site
      tab.displayUrl = buildNsiteUrl(nsite)
      tab.security = null
      tab.failure = null
      tab.tor = { onionAvailable: false, active: tab.kind === 'tor' }
      this.deps.torGuard.set(tab.view.webContents.id, tab.kind === 'tor')
      this.showOnly(tab.id)
      await this.load(tab, buildNsiteUrl(nsite))
      return
    }

    let address: NccAddress
    try {
      address = parseNccAddress(target.url)
    } catch (error) {
      tab.failure = {
        code: 'invalid-address',
        message: error instanceof Error ? error.message : 'Invalid address'
      }
      this.syncState()
      return
    }

    this.deps.activeServices[tab.kind].set(address.pubkey, address.service)
    tab.mode = 'ncc'
    tab.pubkey = address.pubkey
    tab.service = address.service
    const internal = toInternalUrl(address)
    tab.displayUrl = toDisplayUrl(internal)
    tab.security = null
    tab.failure = null
    this.showOnly(tab.id)
    await this.load(tab, internal)
  }

  /** Open a web or search URL, applying the same HTTPS policy as typed addresses. */
  private async openWebUrl(tab: Tab, text: string): Promise<void> {
    const policy = this.deps.httpPolicies[tab.kind]
    const key = webHttpKey(text)
    const http = /^http:\/\//i.test(text)
    const exempt = isHttpExemptUrl(text)

    if (http && key && !exempt && !policy.isAllowed(key)) {
      if (shouldUpgradeHttp(text, policy.mode())) {
        const httpsUrl = upgradeToHttps(text)
        await this.loadWebTarget(tab, httpsUrl, { original: text, key, httpsUrl })
        return
      }
      if (policy.warn()) {
        this.showInsecurePrompt(tab, text, key)
        return
      }
    }

    await this.loadWebTarget(tab, text)
  }

  private async loadWebTarget(
    tab: Tab,
    text: string,
    pending: Tab['pendingHttp'] = null
  ): Promise<void> {
    tab.mode = 'web'
    tab.pubkey = null
    tab.service = null
    tab.displayUrl = text
    tab.security = null
    tab.failure = null
    tab.pendingHttp = pending
    tab.tor = { onionAvailable: false, active: false }
    this.deps.torGuard.set(tab.view.webContents.id, false)
    this.showOnly(tab.id)

    if (isOnionPageUrl(text)) {
      tab.loading = true
      this.syncState()
      try {
        await this.deps.tor.ensureReady()
      } catch (error) {
        await this.loadWebError(
          tab,
          text,
          'tor-unavailable',
          error instanceof Error ? error.message : String(error)
        )
        return
      }
      tab.tor.active = true
      this.deps.torGuard.set(tab.view.webContents.id, true)
    }

    tab.programmatic = true
    try {
      await this.load(tab, text)
    } finally {
      tab.programmatic = false
    }
  }

  private showInsecurePrompt(tab: Tab, url: string, key: string): void {
    const previous = tab.view.webContents.isDestroyed()
      ? tab.displayUrl
      : formatDisplayUrl(tab.view.webContents.getURL())
    // Keep the current tab state intact. If the user cancels, the existing page is
    // still loaded and only the address-bar draft needs restoring.
    tab.displayUrl = url
    tab.pendingHttp = null
    this.pendingInsecure = { tabId: tab.id, url, key, previous }
    this.setOverlay('insecure', true)
    this.syncState()
  }

  /** Resolve the chrome HTTP interstitial. */
  insecureChoice(choice: 'cancel' | 'continue' | 'always'): void {
    const pending = this.pendingInsecure
    if (!pending) return
    const tab = this.tabs.find((entry) => entry.id === pending.tabId)
    this.pendingInsecure = null
    this.setOverlay('insecure', false)

    if (choice === 'cancel' || !tab) {
      if (tab) tab.displayUrl = pending.previous
      this.syncState()
      return
    }
    if (choice === 'always') this.deps.httpPolicies[tab.kind].allow(pending.key)
    void this.loadWebTarget(tab, pending.url)
  }

  private cancelInsecurePrompt(): void {
    const pending = this.pendingInsecure
    if (!pending) return
    this.pendingInsecure = null
    this.setOverlay('insecure', false)
    const tab = this.tabs.find((entry) => entry.id === pending.tabId)
    if (tab) tab.displayUrl = pending.previous
    this.syncState()
  }

  private async loadWebError(
    tab: Tab,
    address: string,
    code: string,
    message: string
  ): Promise<void> {
    const html = renderErrorPage({ code, message, address })
    await this.load(tab, `data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    tab.mode = 'web'
    tab.displayUrl = address
    tab.security = null
    tab.failure = { code, message }
    tab.tor = { onionAvailable: false, active: false }
    this.deps.torGuard.set(tab.view.webContents.id, false)
    this.syncState()
  }

  private async load(tab: Tab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url)
    } catch (error) {
      // Chromium reports aborted navigations as errors too; only surface real failures.
      const message = error instanceof Error ? error.message : String(error)
      if (!/ERR_ABORTED/i.test(message)) {
        tab.failure ??= {
          code: url.startsWith('ncc://') ? 'endpoint-unreachable' : 'load-failed',
          message
        }
      }
      this.syncState()
    }
  }

  private createTab(kind: TabKind = 'normal'): Tab {
    const view = new WebContentsView({
      webPreferences: {
        ...CONTENT_WEB_PREFERENCES,
        partition: this.deps.partitionFor(kind),
        preload: this.deps.contentPreloadPath
      }
    })
    if (kind === 'tor') {
      view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    }
    const tab: Tab = {
      id: `t${this.nextTabId++}`,
      kind,
      view,
      mode: 'blank',
      displayUrl: '',
      pubkey: null,
      service: null,
      security: null,
      failure: null,
      tor: { onionAvailable: false, active: false },
      pendingHttp: null,
      programmatic: false,
      loading: false,
      favicon: null,
      audible: false,
      muted: false
    }

    this.window.contentView.addChildView(view)
    view.setBounds(this.contentBounds())
    view.setVisible(false)
    this.tabs.push(tab)
    this.wireTab(tab)
    this.deps.onContentWebContents?.(view.webContents)
    this.scheduleSessionSave()
    return tab
  }

  /** Clear a private/Tor session only if no tab of that kind appeared meanwhile. */
  private releaseKindIfUnused(kind: TabKind): void {
    if (kind === 'normal') return
    setTimeout(() => {
      if (this.window.isDestroyed()) return
      if (!this.tabs.some((tab) => tab.kind === kind)) this.deps.releaseSession(kind)
    }, 0)
  }

  private activateTab(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    if (this.pendingInsecure && this.pendingInsecure.tabId !== id) {
      this.cancelInsecurePrompt()
    }
    this.activeId = id
    this.showOnly(id)
    this.scheduleSessionSave()
    this.syncState()
  }

  private showOnly(id: string): void {
    const bounds = this.contentBounds()
    for (const tab of this.tabs) {
      const isActive = tab.id === id
      if (isActive) tab.view.setBounds(bounds)
      const visible = isActive && tab.mode !== 'blank' && this.overlays.size === 0
      try {
        tab.view.setVisible(visible)
      } catch {
        tab.view.setBounds(visible ? bounds : { x: 0, y: CHROME_HEIGHT, width: 0, height: 0 })
      }
    }
  }

  private wireTab(tab: Tab): void {
    const contents = tab.view.webContents

    contents.on('did-start-loading', () => {
      tab.loading = true
      this.syncState()
    })

    contents.on('did-stop-loading', () => {
      tab.loading = false
      const url = contents.isDestroyed() ? '' : contents.getURL()
      const script = url ? this.deps.protectionScriptForUrl?.(url, tab.kind) ?? '' : ''
      if (script) void contents.executeJavaScript(script, true).catch(() => undefined)
      this.scheduleSessionSave()
      this.syncState()
    })

    contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      tab.failure = null
      tab.security = null
      const onion = tab.kind === 'tor' || isOnionPageUrl(url)
      tab.tor = { onionAvailable: false, active: onion }
      if (tab.kind !== 'tor') this.deps.torGuard.set(contents.id, onion)
      tab.displayUrl = formatDisplayUrl(url)
      this.applyUrlToTab(tab, url)
      this.syncState()
    })

    contents.on('did-navigate', (_event, url) => {
      tab.displayUrl = formatDisplayUrl(url)
      this.applyUrlToTab(tab, url)
      // Only normal tabs contribute to address-bar suggestions.
      if (tab.kind === 'normal' && /^(ncc:\/\/|nsite:\/\/|https?:\/\/)/i.test(url)) {
        this.deps.omnibox.recordVisit(tab.displayUrl, tabTitle(tab), 'normal')
      }
      this.scheduleSessionSave()
      this.syncState()
    })

    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      tab.displayUrl = formatDisplayUrl(url)
      this.scheduleSessionSave()
      this.syncState()
    })

    contents.on('page-title-updated', () => {
      if (tab.kind === 'normal' && tab.displayUrl) {
        const title = contents.isDestroyed() ? '' : contents.getTitle()
        if (title) this.deps.omnibox.updateTitle(tab.displayUrl, title, 'normal')
      }
      this.syncState()
    })

    contents.on('page-favicon-updated', (_event, favicons) => {
      const candidate = favicons.find((favicon) => /^(https?|ncc|data:image\/)/i.test(favicon))
      if (!candidate) return
      if (candidate.startsWith('data:image/')) {
        if (candidate.length <= 350_000) {
          tab.favicon = candidate
          this.syncState()
        }
        return
      }
      // Main-process fetches are not attributed to a webContents, so apply the
      // Tor-page allowlist here as well; a clearnet favicon would leak the IP.
      if (tab.tor.active && !isAllowedTorUrl(candidate)) return
      const referer = contents.getURL()
      void fetchFavicon(contents.session, candidate, referer).then((dataUrl) => {
        if (!dataUrl || tab.favicon === dataUrl || !this.tabs.includes(tab)) return
        tab.favicon = dataUrl
        this.syncState()
      })
    })

    tab.audible = contents.isCurrentlyAudible()
    tab.muted = contents.isAudioMuted()
    contents.on('audio-state-changed', (event) => {
      tab.audible = event.audible
      tab.muted = contents.isAudioMuted()
      this.syncState()
    })

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      if (/ERR_ABORTED/.test(errorDescription)) return

      if (tab.pendingHttp) {
        const pending = tab.pendingHttp
        tab.pendingHttp = null
        const policy = this.deps.httpPolicies[tab.kind]
        if (policy.isAllowed(pending.key) || (policy.mode() !== 'only' && !policy.warn())) {
          void this.loadWebTarget(tab, pending.original)
        } else {
          this.showInsecurePrompt(tab, pending.original, pending.key)
        }
        return
      }

      tab.failure ??= {
        code: validatedURL.startsWith('ncc://') ? 'endpoint-unreachable' : 'load-failed',
        message: errorDescription
      }
      this.syncState()
    })

    contents.on('render-process-gone', (_event, details) => {
      tab.failure = { code: 'renderer-gone', message: details.reason }
      this.syncState()
    })

    contents.setWindowOpenHandler(({ url }) => {
      void this.openInNewTab(url, tab.kind)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (tab.programmatic) return
      const protocol = safeProtocol(url)
      if (!protocol) return
      if (protocol === 'http:' || protocol === 'https:') {
        const policy = this.deps.httpPolicies[tab.kind]
        const key = webHttpKey(url)
        if (
          protocol === 'http:' &&
          key &&
          !isHttpExemptUrl(url) &&
          !policy.isAllowed(key) &&
          (shouldUpgradeHttp(url, policy.mode()) || policy.warn())
        ) {
          event.preventDefault()
          void this.navigateInTab(tab, url)
          return
        }
      }
      if (
        protocol === 'ncc:' ||
        protocol === 'nsite:' ||
        protocol === 'http:' ||
        protocol === 'https:'
      ) {
        // Same-origin links navigate natively; the origin already names the service or
        // site, so there is nothing to disambiguate here.
        return
      }
      event.preventDefault()
      void shell.openExternal(url)
    })

    contents.on('will-attach-webview', (event) => event.preventDefault())

    installContentContextMenu(contents, {
      getWindow: () => this.window,
      openInNewTab: (url) => {
        void this.openInNewTab(url, tab.kind)
      },
      extensionItems: (url) => this.deps.extensionContextItems?.(url) ?? []
    })

    // Keyboard shortcuts are routed in main so they work while the page has focus.
    contents.on('before-input-event', (event, input) => this.handleInput(event, input))
  }

  private async openInNewTab(url: string, kind: TabKind = 'normal'): Promise<void> {
    const tab = this.createTab(kind)
    this.activateTab(tab.id)
    if (/^https?:\/\//i.test(url) || /^ncc:\/\//i.test(url) || /^nsite:\/\//i.test(url)) {
      await this.navigateInTab(tab, url)
      return
    }
    try {
      await tab.view.webContents.loadURL(url)
    } catch (error) {
      console.warn('[shell] could not open popup:', error)
    }
  }

  private applyUrlToTab(tab: Tab, url: string): void {
    if (url.startsWith('nsite://')) {
      tab.mode = 'nsite'
      try {
        const address = parseNsiteAddress(url)
        tab.pubkey = address.pubkey
        tab.service = address.site
      } catch {
        // The error page's own URL may not parse; keep the previous site.
      }
      return
    }

    if (!url.startsWith('ncc://')) {
      tab.mode = url.startsWith('http') ? 'web' : tab.mode
      if (!url.startsWith('http')) return
      tab.pubkey = null
      tab.service = null
      return
    }

    tab.mode = 'ncc'
    try {
      const address = parseNccAddress(url)
      tab.pubkey = address.pubkey
      tab.service = address.service
    } catch {
      // The error page's own URL may not parse; keep the previous service.
    }
  }

  private activeTab(): Tab | null {
    if (!this.activeId) return null
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null
  }

  private handleInput(event: { preventDefault(): void }, input: Input): void {
    const command = commandForInput(input)
    if (command) {
      event.preventDefault()
      this.runCommand(command)
      return
    }

    if (input.type === 'keyDown' && input.key === 'Escape') {
      const tab = this.activeTab()
      if (tab?.loading) {
        event.preventDefault()
        tab.view.webContents.stop()
      }
    }
  }

  private sendChrome(channel: string, payload?: unknown): boolean {
    if (this.window.isDestroyed()) return false
    this.window.webContents.send(channel, payload)
    return true
  }

  private cycleTab(delta: number): void {
    if (this.tabs.length < 2) return
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId)
    const next = this.tabs[(index + delta + this.tabs.length) % this.tabs.length]
    if (next) this.activateTab(next.id)
  }

  private adjustZoom(delta: number): void {
    const contents = this.activeTab()?.view.webContents
    if (!contents) return
    const next = Math.min(3, Math.max(0.25, contents.getZoomFactor() + delta))
    contents.setZoomFactor(Number(next.toFixed(2)))
  }

  private updateWindowTitle(): void {
    if (this.window.isDestroyed()) return
    const tab = this.activeTab()
    if (!tab) {
      this.window.setTitle('Nostr Navigator')
      return
    }
    const title = tabTitle(tab)
    const label = title && title !== 'New tab' ? title : tab.displayUrl
    if (!label) {
      this.window.setTitle('Nostr Navigator')
      return
    }
    const trimmed = label.length > 90 ? `${label.slice(0, 90)}…` : label
    this.window.setTitle(`${trimmed} — Nostr Navigator`)
  }

  private wireWindow(): void {
    const layout = (): void => {
      const active = this.activeTab()
      if (active) active.view.setBounds(this.contentBounds())
    }

    this.window.on('resize', () => {
      layout()
      this.scheduleSessionSave()
    })
    this.window.on('move', () => this.scheduleSessionSave())
    this.window.on('enter-full-screen', layout)
    this.window.on('leave-full-screen', layout)
    this.window.on('maximize', () => this.syncState())
    this.window.on('unmaximize', () => this.syncState())
    // The quit path enters `before-quit` after the window is gone, so flush on close.
    this.window.on('close', () => this.saveSessionNow())

    this.window.on('closed', () => {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      for (const tab of this.tabs) {
        try {
          tab.view.webContents.close()
        } catch {
          // already gone with the window
        }
      }
      this.tabs.length = 0
      this.activeId = null
      this.deps.releaseSession('private')
      this.deps.releaseSession('tor')
    })
  }

  private restoreTabs(session?: SavedSession | null): void {
    const saved = session?.tabs?.length ? session.tabs : [{ url: '' }]
    const tabs = saved.map((entry) => {
      const tab = this.createTab()
      if (entry.url) void this.navigateInTab(tab, entry.url)
      return tab
    })

    const activeIndex = Math.min(
      Math.max(session?.activeIndex ?? 0, 0),
      Math.max(0, tabs.length - 1)
    )
    const active = tabs[activeIndex]
    if (active) this.activateTab(active.id)
  }

  private scheduleSessionSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveSessionNow(), 600)
    this.onTabsChanged?.()
  }

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const [width, height] = this.window.getContentSize()
    const banner =
      this.overlays.size === 0 && this.bannerFor(this.activeTab()) ? BANNER_HEIGHT : 0
    return {
      x: 0,
      y: CHROME_HEIGHT + banner,
      width,
      height: Math.max(0, height - CHROME_HEIGHT - banner)
    }
  }

  private bannerFor(tab: Tab | null): { tone: 'warn'; title: string; detail: string } | null {
    if (!tab || tab.mode === 'blank' || tab.failure) return null
    let insecure = false
    let overTor = tab.kind === 'tor'
    let url = ''
    if (tab.mode === 'web') {
      url = tab.view.webContents.isDestroyed() ? tab.displayUrl : tab.view.webContents.getURL()
      try {
        insecure = new URL(url).protocol === 'http:'
      } catch {
        insecure = /^http:\/\//i.test(url)
      }
      overTor = overTor || isOnionPageUrl(url)
    } else if (tab.mode === 'ncc') {
      insecure = tab.security?.transport === 'plaintext'
      overTor = overTor || tab.security?.onion === true
      url = tab.displayUrl
    }
    if (!insecure) return null
    return overTor
      ? {
          tone: 'warn',
          title: 'HTTP over Tor',
          detail: 'Tor encrypts the path, but this page has no TLS layer.'
        }
      : {
          tone: 'warn',
          title: 'Not secure',
          detail: 'This page uses HTTP. Anyone on the network can read or modify it.'
        }
  }

  private insecurePromptFor(tab: Tab | null) {
    const pending = this.pendingInsecure
    if (!pending || !tab || pending.tabId !== tab.id) return null
    let host = pending.url
    try {
      host = new URL(pending.url).host
    } catch {
      // Keep the raw URL when it is not parseable.
    }
    return {
      url: pending.url,
      host,
      ephemeral: tab.kind !== 'normal',
      tor: tab.kind === 'tor',
      mode: this.deps.httpPolicies[tab.kind].mode()
    }
  }

  private syncState(): void {
    if (this.window.isDestroyed()) return
    this.updateWindowTitle()
    const active = this.activeTab()
    if (active && this.overlays.size === 0) {
      active.view.setBounds(this.contentBounds())
    }
    this.window.webContents.send('ncc:state', this.getState())
  }
}

function tabTitle(tab: Tab): string {
  const contents = tab.view.webContents
  if (contents.isDestroyed()) return tab.displayUrl || 'New tab'
  const title = contents.getTitle()
  if (title && !title.startsWith('ncc://') && !title.startsWith('http')) return title
  return tab.displayUrl || 'New tab'
}

function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

function formatDisplayUrl(url: string): string {
  if (url.startsWith('ncc://')) return toDisplayUrl(url)
  if (url.startsWith('nsite://')) return toNsiteDisplayUrl(url)
  return url
}

function isOnionPageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    return isOnionHost(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

function historyLabel(title: string, url: string): string {
  const label = title?.trim() || url
  return label.length > 100 ? `${label.slice(0, 100)}…` : label
}

/**
 * Restore the saved window size, but only restore the position when a meaningful part
 * of the window still lands on a connected display (monitors get unplugged).
 */
function restoreWindowBounds(
  saved?: SavedWindow
): { width: number; height: number; x?: number; y?: number } {
  const width = saved?.width ?? 1280
  const height = saved?.height ?? 860
  if (!saved || saved.x === undefined || saved.y === undefined) return { width, height }

  const bounds = { x: saved.x, y: saved.y, width, height }
  const visible = screen.getAllDisplays().some((display) => {
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, display.workArea.x + display.workArea.width) -
        Math.max(bounds.x, display.workArea.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, display.workArea.y + display.workArea.height) -
        Math.max(bounds.y, display.workArea.y)
    )
    return overlapX * overlapY >= 100 * 100
  })

  return visible ? bounds : { width, height }
}
