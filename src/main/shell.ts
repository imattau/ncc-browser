import {
  BrowserWindow,
  WebContentsView,
  shell,
  type Input,
  type WebContents
} from 'electron'
import { parseNccAddress, toDisplayUrl, toInternalUrl, type NccAddress } from '@shared/ncc-url'
import { buildNsiteUrl, parseNsiteAddress, type NsiteAddress } from '@shared/nsite-url'
import type { NsiteActivity } from './nsite/protocol'
import { BANNER_HEIGHT, chromeInsets, toggleBookmarksPatch } from '@shared/layout'
import type { CommandId } from '@shared/commands'
import { reorderTabs } from '@shared/tabs'
import { appearanceBootArgument } from '@shared/appearance'
import { installChromeContextMenu } from './context-menu'
import { commandForInput } from './shortcuts'
import { windowBackground } from './appearance'
import type { BookmarkStore } from './bookmarks'
import type { SavedSession, SavedWindowSession, SessionStore } from './session-store'
import type { ExtensionPage } from '@shared/extensions'
import type {
  AppearanceConfig,
  AppConfig,
  Bookmark,
  DownloadNotice,
  NavState,
  OmniboxSuggestion,
  TabHistory,
  TabKind
} from '@shared/types'
import type { PasswordPage } from '@shared/passwords'
import type { ProtocolActivity } from './protocol'
import type { EndpointHealth } from './ncc/health'
import type { TransportPolicy } from './ncc/transport'
import type { OmniboxService, OmniboxTab } from './omnibox'
import type { HttpPolicy } from './security'
import type { TorGuard } from './tor/guard'
import { restoreWindowBounds } from './shell/bounds'
import { runShellCommand } from './shell/commands'
import { formatDisplayUrl, isOnionPageUrl, tabTitle } from './shell/format'
import type { ShellInternals } from './shell/internals'
import { applyUrlToTab, loadWebTarget, navigateInTab as navigateTabTo } from './shell/navigation'
import { wireTab as wireTabListeners } from './shell/wiring'
import {
  showBookmarkListMenu,
  showBookmarkMenu,
  showHistoryMenu,
  showNewTabMenu,
  showTabMenu
} from './shell/menus'
import { browserShellFor, browserShellForTabContents, browserShells, registerShell, unregisterShell } from './shell/registry'
import { isEmptyTab, restoredTabPlan, savedWindowSession } from './shell/session'
import { buildNavState, tabSummaries } from './shell/state'
import { contentWebPreferences, type Tab } from './shell/types'

// Keep the historical entry point working: other main modules import the registry here.
export { browserShellFor, browserShellForTabContents, browserShells } from './shell/registry'
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
  initialBounds?: { x: number; y: number }
  deferInitialTabs?: boolean
  transport: TransportPolicy
  tor: TorManager
  torGuard: TorGuard
  protectionScriptForUrl?: (url: string, kind: TabKind) => string
  health: EndpointHealth
  preferTor: () => boolean
  appearance: () => AppearanceConfig
  /** Save an appearance change made from a command and apply it to every window. */
  updateAppearance: (patch: Partial<AppearanceConfig>) => void
  onContentWebContents?: (contents: WebContents) => void
  extensionContextItems?: (url: string) => Array<{ label: string; click: () => void }>
  /** Drop a cached NCC locator before a forced reload. */
  invalidateSite?: (url: string, kind: TabKind) => void
  /** Remember a private share this identity just decrypted (normal tabs only). */
  onHostedResolved?: (activity: ProtocolActivity) => void
  createWindow?: (bounds?: { x: number; y: number }) => BrowserShell
  onSessionChanged?: () => void
}

/**
 * Window layout and tab management: a trusted local chrome renderer on top, and one
 * sandboxed WebContentsView per tab below it. All tabs share a single content session
 * so an npub keeps one origin (and one cookie jar) across tabs; requests are attributed
 * to the right service through the referrer, not through per-tab origins.
 */
export class BrowserShell {
  readonly window: BrowserWindow
  private readonly chromeWebContentsId: number
  private readonly deps: ShellDeps
  private readonly internals: ShellInternals
  private readonly tabs: Tab[] = []
  private extensionPanel: WebContentsView | null = null
  private extensionPanelOwner: string | null = null
  private extensionPanelWidth = 380
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
    this.internals = {
      deps,
      syncState: () => this.syncState(),
      scheduleSessionSave: () => this.scheduleSessionSave(),
      activateTab: (id) => this.activateTab(id),
      showOnly: (id) => this.showOnly(id),
      applyUrlToTab,
      openInNewTab: (url, kind) => this.openInNewTab(url, kind),
      handleInput: (event, input) => this.handleInput(event, input),
      hasTab: (tab) => this.tabs.includes(tab),
      showInsecurePrompt: (tab, url, key) => this.showInsecurePrompt(tab, url, key),
      closeTab: (id) => this.closeTab(id)
    }
    const savedWindow = deps.initialSession?.window
    const bounds = deps.initialBounds
      ? { ...restoreWindowBounds(undefined), ...deps.initialBounds }
      : restoreWindowBounds(savedWindow)

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

    this.chromeWebContentsId = this.window.webContents.id
    this.wireWindow()
    registerShell(this.chromeWebContentsId, this)
    installChromeContextMenu(this.window.webContents, () => this.window)
    this.window.webContents.on('before-input-event', (event, input) =>
      this.handleInput(event, input)
    )
    this.window.on('blur', () => this.sendChrome('ncc:close-menu'))
    // A chrome reload (dev HMR, devtools) loses which overlay owned the surface.
    this.window.webContents.on('did-finish-load', () => this.clearOverlays())
    if (!deps.deferInitialTabs) this.restoreTabs(deps.initialSession)
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

  /** Notify live page providers after the active NIP-07 account changes. */
  notifySignerAccountsChanged(publicKey: string | null): void {
    for (const tab of this.tabs) {
      const contents = tab.view.webContents
      if (tab.kind !== 'normal' || contents.isDestroyed()) continue
      contents.send('nip07:accounts-changed', publicKey ? [publicKey] : [])
    }
  }

  /**
   * Live contents for automation. Private and Tor tabs are never handed out. With
   * `load`, a restored tab that has not been loaded yet is shown and loaded first.
   */
  automationContents(tabId: string, options: { load?: boolean } = {}): WebContents | null {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (!tab || tab.kind !== 'normal') return null
    if (options.load && tab.pendingUrl) this.activateTab(tab.id)
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

  /** Match the native window background to the theme, and the page to the layout. */
  applyAppearance(): void {
    if (this.window.isDestroyed()) return
    this.window.setBackgroundColor(windowBackground())
    this.syncState()
  }

  tabsAreVertical(): boolean {
    return this.deps.appearance().tabLayout === 'vertical'
  }

  toggleTabLayout(): void {
    const { tabLayout } = this.deps.appearance()
    this.deps.updateAppearance({ tabLayout: tabLayout === 'vertical' ? 'horizontal' : 'vertical' })
  }

  toggleBookmarksVisibility(): void {
    this.deps.updateAppearance(toggleBookmarksPatch(this.deps.appearance()))
  }

  getState(): NavState {
    const active = this.activeTab()
    const contents = active?.view.webContents
    const history = contents?.navigationHistory

    return buildNavState({
      active: active
        ? {
            mode: active.mode,
            displayUrl: active.displayUrl,
            url: contents && !contents.isDestroyed() ? contents.getURL() : '',
            title: tabTitle(active),
            loading: active.loading,
            canGoBack: history?.canGoBack() ?? false,
            canGoForward: history?.canGoForward() ?? false,
            security: active.security,
            failure: active.failure,
            tor: active.tor,
            kind: active.kind
          }
        : null,
      tabs: tabSummaries(this.tabs),
      activeTabId: this.activeId,
      preferTor: this.deps.preferTor(),
      windowMaximized: this.window.isMaximized(),
      banner: this.bannerFor(active),
      insecurePrompt: this.insecurePromptFor(active)
    })
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
    if (target.kind !== 'normal') this.closeExtensionPanel()

    try {
      // A tab whose page closed itself (e.g. an SSO popup after `window.close()`)
      // reaches here with its webContents already gone; there is nothing left to
      // stop/close in that case, just the view to detach.
      const contents = target.view.webContents
      if (contents && !contents.isDestroyed()) {
        contents.stop()
        this.deps.torGuard.delete(contents.id)
        contents.close()
      }
      this.window.contentView.removeChildView(target.view)
    } catch (error) {
      console.warn('[shell] could not close tab:', error)
    }

    if (this.activeId === target.id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null
      this.activeId = next?.id ?? null
      if (next) {
        this.showOnly(next.id)
        this.loadPendingTab(next)
      }
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

  detachTab(id: string, screenX: number, screenY: number): void {
    const tab = this.tabs.find((entry) => entry.id === id)
    if (!tab || !this.deps.createWindow) return
    const target = this.deps.createWindow({ x: Math.round(screenX - 520), y: Math.round(screenY - 18) })
    this.transferTabTo(target, tab)
  }

  openTabInNewWindow(id: string): void {
    const tab = this.tabs.find((entry) => entry.id === id)
    if (!tab || !this.deps.createWindow) return
    const [x, y] = this.window.getPosition()
    const target = this.deps.createWindow({ x: x + 48, y: y + 32 })
    this.transferTabTo(target, tab)
  }

  private transferTabTo(target: BrowserShell, tab: Tab): void {
    if (target === this || !this.tabs.includes(tab)) return
    if (this.pendingInsecure?.tabId === tab.id) this.cancelInsecurePrompt()
    const previousIndex = this.tabs.indexOf(tab)
    this.tabs.splice(previousIndex, 1)
    this.window.contentView.removeChildView(tab.view)
    if (this.activeId === tab.id) {
      const replacement = this.tabs[previousIndex] ?? this.tabs[previousIndex - 1] ?? null
      this.activeId = replacement?.id ?? null
      if (replacement) {
        this.showOnly(replacement.id)
        this.loadPendingTab(replacement)
      }
    }
    tab.id = `t${target.nextTabId++}`
    tab.owner = target
    target.tabs.push(tab)
    target.window.contentView.addChildView(tab.view)
    target.activateTab(tab.id)
    this.scheduleSessionSave()
    target.scheduleSessionSave()
    if (this.tabs.length === 0) this.closeWindow()
  }

  duplicateTab(id?: string): string | null {
    const source = id ? this.tabs.find((tab) => tab.id === id) : this.activeTab()
    if (!source) return null
    const tab = this.createTab(source.kind)
    this.activateTab(tab.id)
    if (!isEmptyTab(source) && source.displayUrl) {
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
    showNewTabMenu(this)
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
      this.extensionPanel?.setVisible(false)
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
    this.layoutContentViews()
    if (!activeTab) return
    if (activeTab.mode === 'blank') return
    activeTab.view.setBounds(this.pageContentBounds())
    try {
      activeTab.view.setVisible(true)
    } catch {
      // Fallback handled by showOnly on the next activation.
    }
  }

  /** Show a sandboxed extension page in the browser-owned right side panel. */
  toggleExtensionPanel(id: string, page: string): void {
    const current = this.extensionPanel
    if (current && !current.webContents.isDestroyed() && current.webContents.getURL().includes(`://${id}/`)) {
      this.closeExtensionPanel()
      return
    }
    this.closeExtensionPanel()
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.contentPreloadPath,
        partition: this.deps.partitionFor('normal'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        safeDialogs: true
      }
    })
    this.extensionPanel = view
    this.extensionPanelOwner = id
    this.window.contentView.addChildView(view)
    view.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.warn('[shell] extension panel preload failed:', preloadPath, error.message)
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|ncc):\/\//i.test(url)) this.newTab(url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`ncc-ext://${id}/`)) event.preventDefault()
    })
    view.webContents.on('destroyed', () => {
      if (this.extensionPanel === view) { this.extensionPanel = null; this.extensionPanelOwner = null }
      if (!this.window.isDestroyed()) this.layoutContentViews()
    })
    view.webContents.loadURL(`ncc-ext://${id}/${page.replace(/^\/+/, '')}`).catch((error) => {
      console.warn('[shell] could not open extension panel:', error)
    })
    this.layoutContentViews()
  }

  closeExtensionPanel(owner?: string): void {
    if (owner !== undefined && this.extensionPanelOwner !== owner) return
    const view = this.extensionPanel
    if (!view) return
    this.extensionPanel = null
    this.extensionPanelOwner = null
    if (!this.window.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(view)
        if (!view.webContents.isDestroyed()) view.webContents.close()
      } catch { /* already destroyed with the window */ }
      this.layoutContentViews()
    }
  }

  setExtensionPanelWidth(owner: string, width: number): void {
    if (this.extensionPanelOwner !== owner) return
    this.extensionPanelWidth = Math.max(280, Math.min(600, Math.round(width)))
    this.layoutContentViews()
  }

  private clearOverlays(): void {
    if (this.overlays.size === 0) return
    this.overlays.clear()
    if (this.activeId) this.showOnly(this.activeId)
  }

  runCommand(command: CommandId): void {
    runShellCommand(this, command)
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
    showHistoryMenu(this, direction)
  }

  showTabMenu(id: string): void {
    showTabMenu(this, id)
  }

  /** The fields the tab context menu needs, without exposing the tab list. */
  tabMenuInfo(id: string): {
    kind: TabKind
    displayUrl: string
    muted: boolean
    index: number
    count: number
  } | null {
    const tab = this.tabs.find((entry) => entry.id === id)
    if (!tab) return null
    return {
      kind: tab.kind,
      displayUrl: tab.displayUrl,
      muted: tab.muted,
      index: this.tabs.indexOf(tab),
      count: this.tabs.length
    }
  }

  getBookmarks(): Bookmark[] {
    return this.deps.bookmarks.list()
  }

  toggleBookmark(): Bookmark[] {
    const page = this.getActivePage()
    if (!page) return this.getBookmarks()
    const list = this.deps.bookmarks.toggle(page.url, page.title)
    this.publishBookmarks(list)
    return list
  }

  removeBookmark(url: string): Bookmark[] {
    const list = this.deps.bookmarks.remove(url)
    this.publishBookmarks(list)
    return list
  }

  /** Every window can have bookmarks on screen, so all of them hear about a change. */
  private publishBookmarks(list: Bookmark[]): void {
    for (const browserShell of browserShells()) browserShell.sendToChrome('ncc:bookmarks', list)
  }

  /** Right-click menu for a bookmark in the toolbar or sidebar. */
  showBookmarkMenu(url: string): void {
    if (this.deps.bookmarks.has(url)) showBookmarkMenu(this, url)
  }

  /** The bookmarks that did not fit, as a native menu so it can cover the page. */
  showBookmarkListMenu(fromIndex: number): void {
    showBookmarkListMenu(this, this.getBookmarks().slice(Math.max(0, fromIndex)))
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
      .filter((tab) => !isEmptyTab(tab) && tab.displayUrl && !tab.view.webContents.isDestroyed())
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
        !isEmptyTab(tab) &&
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

    if (this.deps.onSessionChanged) this.deps.onSessionChanged()
    else this.deps.sessionStore.save(this.sessionSnapshot())
  }

  sessionSnapshot(): SavedWindowSession {
    const bounds = this.window.getNormalBounds()
    return savedWindowSession(
      this.tabs,
      this.activeId,
      bounds,
      this.window.isMaximized()
    )
  }

  usesTabKind(kind: TabKind): boolean {
    return this.tabs.some((tab) => tab.kind === kind)
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
    // A document belongs to the tab whose transport fetched it: an onion document to
    // the Tor tab, a direct one to the normal tab. Two tabs can show the same service
    // at once, so updating every match would mark the direct tab as "over Tor" — and
    // `isTorService()` would then push its own subresources through Tor.
    const owners = tabs.filter((tab) =>
      activity.viaTor === true ? tab.kind === 'tor' : tab.kind !== 'tor'
    )
    // Keep showing failures when no tab owns the activity (for example a failure
    // reported for a service that only has a Tor tab open).
    for (const tab of owners.length > 0 ? owners : tabs) {
      const active =
        !activity.failureCode && (tab.kind === 'tor' || activity.viaTor === true)
      tab.tor = { onionAvailable, active }
      // A Tor tab may still open clearnet pages, so only normal and private tabs need
      // the strict guard while they are showing Tor content.
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
    if (
      !activity.failureCode &&
      activity.locator?.encrypted === true &&
      tabs.some((tab) => tab.kind === 'normal')
    ) {
      this.deps.onHostedResolved?.(activity)
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
    await navigateTabTo(this.internals, tab, input)
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
    void loadWebTarget(this.internals, tab, pending.url)
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

  private createTab(kind: TabKind = 'normal'): Tab {
    const view = new WebContentsView({
      webPreferences: {
        ...contentWebPreferences(kind),
        partition: this.deps.partitionFor(kind),
        preload: this.deps.contentPreloadPath
      }
    })
    if (kind === 'tor') {
      view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    }
    const tab: Tab = {
      owner: this,
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
      if (!browserShells().some((shell) => shell.usesTabKind(kind))) this.deps.releaseSession(kind)
    }, 0)
  }

  private activateTab(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    if (this.pendingInsecure && this.pendingInsecure.tabId !== id) {
      this.cancelInsecurePrompt()
    }
    this.activeId = id
    if (this.activeTab()?.kind !== 'normal') this.closeExtensionPanel()
    this.showOnly(id)
    this.scheduleSessionSave()
    this.syncState()
    const shown = this.activeTab()
    if (shown) this.loadPendingTab(shown)
  }

  private loadPendingTab(tab: Tab): void {
    const url = tab.pendingUrl
    if (!url) return
    tab.pendingUrl = null
    void this.navigateInTab(tab, url)
  }

  private showOnly(id: string): void {
    this.layoutContentViews()
    const bounds = this.pageContentBounds()
    for (const tab of this.tabs) {
      const isActive = tab.id === id
      if (isActive) tab.view.setBounds(this.pageContentBounds())
      const visible = isActive && tab.mode !== 'blank' && this.overlays.size === 0
      try {
        tab.view.setVisible(visible)
      } catch {
        tab.view.setBounds(visible ? bounds : { x: bounds.x, y: bounds.y, width: 0, height: 0 })
      }
    }
  }

  private layoutContentViews(): void {
    if (this.window.isDestroyed()) return
    const pageBounds = this.pageContentBounds()
    const active = this.activeTab()
    if (active) active.view.setBounds(pageBounds)
    const panel = this.extensionPanel
    if (panel && !panel.webContents.isDestroyed()) {
      const fullBounds = this.contentBounds()
      const width = Math.min(this.extensionPanelWidth, Math.max(280, fullBounds.width - 300))
      panel.setBounds({ x: fullBounds.x + fullBounds.width - width, y: fullBounds.y, width, height: fullBounds.height })
      panel.setVisible(this.overlays.size === 0 && active?.kind === 'normal')
    }
  }

  private wireTab(tab: Tab): void {
    wireTabListeners(this.internals, tab)
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
      this.layoutContentViews()
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
      unregisterShell(this.chromeWebContentsId)
      this.closeExtensionPanel()
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
      if (this.deps.onSessionChanged) this.deps.onSessionChanged()
      if (!browserShells().some((shell) => shell.usesTabKind('private'))) this.deps.releaseSession('private')
      if (!browserShells().some((shell) => shell.usesTabKind('tor'))) this.deps.releaseSession('tor')
    })
  }

  private restoreTabs(session?: SavedSession | null): void {
    const plan = restoredTabPlan(session)
    // Only the active tab loads now; the others load when first shown, so a large
    // session does not compete with itself at startup.
    const tabs = plan.tabs.map((entry) => {
      const tab = this.createTab()
      if (entry.url) {
        tab.pendingUrl = entry.url
        tab.displayUrl = formatDisplayUrl(entry.url)
      }
      return tab
    })
    const active = tabs[plan.activeIndex]
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
    const { top, left } = chromeInsets(this.deps.appearance())
    return {
      x: left,
      y: top + banner,
      width: Math.max(0, width - left),
      height: Math.max(0, height - top - banner)
    }
  }

  private pageContentBounds(): { x: number; y: number; width: number; height: number } {
    const bounds = this.contentBounds()
    if (!this.extensionPanel) return bounds
    return { ...bounds, width: Math.max(300, bounds.width - this.extensionPanelWidth) }
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
