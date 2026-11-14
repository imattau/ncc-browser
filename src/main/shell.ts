import { BrowserWindow, WebContentsView, shell, type WebContents } from 'electron'
import { parseNccAddress, toDisplayUrl, toInternalUrl, type NccAddress } from '@shared/ncc-url'
import { CHROME_HEIGHT } from '@shared/layout'
import type {
  DownloadNotice,
  NavState,
  PageMode,
  SecurityInfo,
  TabSummary
} from '@shared/types'
import type { ProtocolActivity } from './protocol'

export interface ShellDeps {
  preloadPath: string
  rendererUrl?: string
  rendererFile: string
  activeService: Map<string, string>
  onContentWebContents?: (contents: WebContents) => void
}

interface Tab {
  id: string
  view: WebContentsView
  mode: PageMode
  displayUrl: string
  pubkey: string | null
  service: string | null
  security: SecurityInfo | null
  failure: { code: string; message: string } | null
  loading: boolean
}

const CONTENT_WEB_PREFERENCES = {
  partition: 'persist:ncc-content',
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

  constructor(deps: ShellDeps) {
    this.deps = deps

    this.window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 760,
      minHeight: 480,
      backgroundColor: '#0b0c10',
      show: false,
      title: 'NCC Browser',
      webPreferences: {
        preload: deps.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })

    this.wireWindow()
    this.window.once('ready-to-show', () => this.window.show())
  }

  loadChrome(): void {
    if (this.deps.rendererUrl) {
      void this.window.loadURL(this.deps.rendererUrl)
    } else {
      void this.window.loadFile(this.deps.rendererFile)
    }
  }

  getState(): NavState {
    const active = this.activeTab()
    const contents = active?.view.webContents
    const history = contents?.navigationHistory

    const tabs: TabSummary[] = this.tabs.map((tab) => ({
      id: tab.id,
      title: tabTitle(tab),
      url: tab.displayUrl,
      loading: tab.loading
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
      tabs,
      activeTabId: this.activeId
    }
  }

  newTab(input?: string): string {
    const tab = this.createTab()
    this.activateTab(tab.id)
    if (input) void this.navigateInTab(tab, input)
    return tab.id
  }

  closeTab(id?: string): void {
    const target = id ? this.tabs.find((tab) => tab.id === id) : this.activeTab()
    if (!target) return

    const index = this.tabs.indexOf(target)
    this.tabs.splice(index, 1)

    try {
      target.view.webContents.stop()
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

    this.syncState()
  }

  selectTab(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    this.activateTab(id)
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

  /** Called by the protocol handler for document-level activity only. */
  reportActivity(activity: ProtocolActivity): void {
    const tab = this.findActivityTab(activity)
    if (!tab) return

    if (activity.failureCode) {
      tab.failure = { code: activity.failureCode, message: activity.failureCode }
      tab.security = null
    } else {
      tab.failure = null
      tab.security = {
        transport: activity.transport,
        host: activity.endpointHost ?? '',
        pinned: activity.pinned
      }
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

    if (/^https?:\/\//i.test(text)) {
      tab.mode = 'web'
      tab.pubkey = null
      tab.service = null
      tab.displayUrl = text
      tab.security = null
      tab.failure = null
      await this.load(tab, text)
      return
    }

    let address: NccAddress
    try {
      address = parseNccAddress(text)
    } catch (error) {
      tab.failure = {
        code: 'invalid-address',
        message: error instanceof Error ? error.message : 'Invalid address'
      }
      this.syncState()
      return
    }

    this.deps.activeService.set(address.pubkey, address.service)
    tab.mode = 'ncc'
    tab.pubkey = address.pubkey
    tab.service = address.service
    const internal = toInternalUrl(address)
    tab.displayUrl = toDisplayUrl(internal)
    tab.security = null
    tab.failure = null
    await this.load(tab, internal)
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

  private createTab(): Tab {
    const view = new WebContentsView({ webPreferences: { ...CONTENT_WEB_PREFERENCES } })
    const tab: Tab = {
      id: `t${this.nextTabId++}`,
      view,
      mode: 'blank',
      displayUrl: '',
      pubkey: null,
      service: null,
      security: null,
      failure: null,
      loading: false
    }

    this.window.contentView.addChildView(view)
    view.setBounds(this.contentBounds())
    view.setVisible(false)
    this.tabs.push(tab)
    this.wireTab(tab)
    this.deps.onContentWebContents?.(view.webContents)
    return tab
  }

  private activateTab(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    this.activeId = id
    this.showOnly(id)
    this.syncState()
  }

  private showOnly(id: string): void {
    const bounds = this.contentBounds()
    for (const tab of this.tabs) {
      const isActive = tab.id === id
      if (isActive) tab.view.setBounds(bounds)
      try {
        tab.view.setVisible(isActive)
      } catch {
        tab.view.setBounds(isActive ? bounds : { x: 0, y: CHROME_HEIGHT, width: 0, height: 0 })
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
      this.syncState()
    })

    contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      tab.failure = null
      tab.security = null
      tab.displayUrl = formatDisplayUrl(url)
      this.applyUrlToTab(tab, url)
      this.syncState()
    })

    contents.on('did-navigate', (_event, url) => {
      tab.displayUrl = formatDisplayUrl(url)
      this.applyUrlToTab(tab, url)
      this.syncState()
    })

    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      tab.displayUrl = formatDisplayUrl(url)
      this.syncState()
    })

    contents.on('page-title-updated', () => this.syncState())

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      if (/ERR_ABORTED/.test(errorDescription)) return
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
      void this.openInNewTab(url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      const protocol = safeProtocol(url)
      if (!protocol) return
      if (protocol === 'ncc:' || protocol === 'http:' || protocol === 'https:') {
        // Same-service links navigate natively. Service changes are expressed with the
        // explicit /_/<service>/ form, which the protocol handler routes unambiguously;
        // root-relative links are attributed to the page's service through the referrer.
        return
      }
      event.preventDefault()
      void shell.openExternal(url)
    })

    contents.on('will-attach-webview', (event) => event.preventDefault())
  }

  private async openInNewTab(url: string): Promise<void> {
    const tab = this.createTab()
    this.activateTab(tab.id)
    if (/^https?:\/\//i.test(url) || /^ncc:\/\//i.test(url)) {
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

  private findActivityTab(activity: ProtocolActivity): Tab | null {
    const active = this.activeTab()
    if (
      active &&
      active.pubkey === activity.pubkey &&
      active.service === activity.service
    ) {
      return active
    }
    return (
      this.tabs.find(
        (tab) => tab.pubkey === activity.pubkey && tab.service === activity.service
      ) ?? null
    )
  }

  private activeTab(): Tab | null {
    if (!this.activeId) return null
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null
  }

  private wireWindow(): void {
    const layout = (): void => {
      const active = this.activeTab()
      if (active) active.view.setBounds(this.contentBounds())
    }

    this.window.on('resize', layout)
    this.window.on('enter-full-screen', layout)
    this.window.on('leave-full-screen', layout)

    this.window.on('closed', () => {
      for (const tab of this.tabs) {
        try {
          tab.view.webContents.close()
        } catch {
          // already gone with the window
        }
      }
      this.tabs.length = 0
      this.activeId = null
    })
  }

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const [width, height] = this.window.getContentSize()
    return {
      x: 0,
      y: CHROME_HEIGHT,
      width,
      height: Math.max(0, height - CHROME_HEIGHT)
    }
  }

  private syncState(): void {
    if (this.window.isDestroyed()) return
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
  return url.startsWith('ncc://') ? toDisplayUrl(url) : url
}
