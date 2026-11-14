import { BrowserWindow, WebContentsView, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { parseNccAddress, toLoadUrl } from '@shared/ncc-url'
import { TOOLBAR_HEIGHT } from '@shared/layout'
import type { NavState, PageMode, SecurityInfo } from '@shared/types'
import type { ProtocolActivity } from './protocol'

export interface ShellDeps {
  preloadPath: string
  rendererUrl?: string
  rendererFile: string
  activeService: Map<string, string>
  onContentWebContents: (contents: WebContents) => void
}

/**
 * Owns the window layout: a trusted local chrome renderer on top, and one sandboxed
 * WebContentsView for remote content below it.
 */
export class BrowserShell {
  readonly window: BrowserWindow
  readonly content: WebContentsView
  private readonly deps: ShellDeps

  private mode: PageMode = 'blank'
  private displayUrl = ''
  private loading = false
  private security: SecurityInfo | null = null
  private failure: { code: string; message: string } | null = null
  private contentVisible = true

  constructor(deps: ShellDeps) {
    this.deps = deps

    this.window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 720,
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

    this.content = new WebContentsView({
      webPreferences: {
        partition: 'persist:ncc-content',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        safeDialogs: true
      }
    })

    this.window.contentView.addChildView(this.content)
    this.content.setBounds(this.contentBounds())
    this.setContentVisible(false)

    this.wireContent()
    this.wireWindow()

    this.window.once('ready-to-show', () => this.window.show())
    this.deps.onContentWebContents(this.content.webContents)
  }

  loadChrome(): void {
    if (this.deps.rendererUrl) {
      void this.window.loadURL(this.deps.rendererUrl)
    } else {
      void this.window.loadFile(this.deps.rendererFile)
    }
  }

  getState(): NavState {
    const history = this.content.webContents.navigationHistory
    return {
      mode: this.mode,
      displayUrl: this.displayUrl,
      url: this.content.webContents.getURL(),
      title: this.content.webContents.getTitle(),
      loading: this.loading,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      security: this.security,
      failure: this.failure
    }
  }

  async navigate(input: string): Promise<void> {
    const text = input.trim()
    if (!text) return

    if (/^https?:\/\//i.test(text)) {
      this.mode = 'web'
      this.security = null
      this.failure = null
      this.setContentVisible(true)
      await this.load(text)
      return
    }

    try {
      const address = parseNccAddress(text)
      this.deps.activeService.set(address.pubkey, address.service)
      this.mode = 'ncc'
      this.security = null
      this.failure = null
      this.setContentVisible(true)
      await this.load(toLoadUrl(address))
    } catch (error) {
      this.failure = {
        code: 'invalid-address',
        message: error instanceof Error ? error.message : 'Invalid address'
      }
      this.syncState()
    }
  }

  back(): void {
    const history = this.content.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward(): void {
    const history = this.content.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(): void {
    if (this.contentVisible) this.content.webContents.reload()
    else this.syncState()
  }

  stop(): void {
    this.content.webContents.stop()
  }

  /** Called by the protocol handler for document-level activity only. */
  reportActivity(activity: ProtocolActivity): void {
    if (activity.failureCode) {
      this.failure = { code: activity.failureCode, message: activity.failureCode }
      this.security = null
    } else {
      this.failure = null
      this.security = {
        transport: activity.transport,
        host: activity.endpointHost ?? '',
        pinned: activity.pinned
      }
    }
    this.syncState()
  }

  private async load(url: string): Promise<void> {
    try {
      await this.content.webContents.loadURL(url)
    } catch (error) {
      // Chromium reports aborted navigations as errors too; only surface real failures.
      const message = error instanceof Error ? error.message : String(error)
      if (!/ERR_ABORTED/i.test(message)) {
        this.failure ??= { code: 'endpoint-unreachable', message }
      }
      this.syncState()
    }
  }

  private wireContent(): void {
    const contents = this.content.webContents

    contents.on('did-start-loading', () => {
      this.loading = true
      this.syncState()
    })

    contents.on('did-stop-loading', () => {
      this.loading = false
      this.syncState()
    })

    contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      this.failure = null
      this.security = null
      this.displayUrl = url
      this.mode = url.startsWith('ncc://')
        ? 'ncc'
        : url.startsWith('http')
          ? 'web'
          : this.mode
      this.syncState()
    })

    contents.on('did-navigate', (_event, url) => {
      this.displayUrl = url
      this.syncState()
    })

    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      this.displayUrl = url
      this.syncState()
    })

    contents.on('page-title-updated', () => this.syncState())

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      if (/ERR_ABORTED/.test(errorDescription)) return
      this.failure ??= {
        code: validatedURL.startsWith('ncc://') ? 'endpoint-unreachable' : 'load-failed',
        message: errorDescription
      }
      this.syncState()
    })

    contents.on('render-process-gone', (_event, details) => {
      this.failure = { code: 'renderer-gone', message: details.reason }
      this.syncState()
    })

    contents.setWindowOpenHandler(({ url }) => {
      void this.navigate(url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      const protocol = safeProtocol(url)
      if (protocol && protocol !== 'ncc:' && protocol !== 'http:' && protocol !== 'https:') {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })

    contents.on('will-attach-webview', (event) => event.preventDefault())
  }

  private wireWindow(): void {
    this.window.on('resize', () => this.content.setBounds(this.contentBounds()))
    this.window.on('enter-full-screen', () => this.content.setBounds(this.contentBounds()))
    this.window.on('leave-full-screen', () => this.content.setBounds(this.contentBounds()))

    this.window.on('closed', () => {
      // WebContentsView children are destroyed with the window.
    })
  }

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const [width, height] = this.window.getContentSize()
    return {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT)
    }
  }

  private setContentVisible(visible: boolean): void {
    if (this.contentVisible === visible) return
    this.contentVisible = visible
    if (visible) {
      this.content.setBounds(this.contentBounds())
    }
    try {
      this.content.setVisible(visible)
    } catch {
      // Older Electron builds lack View.setVisible; bounds collapse does the job.
      this.content.setBounds(
        visible ? this.contentBounds() : { x: 0, y: TOOLBAR_HEIGHT, width: 0, height: 0 }
      )
    }
    if (!visible) this.syncState()
  }

  private syncState(): void {
    if (this.window.isDestroyed()) return
    if (!this.contentVisible) {
      this.mode = 'blank'
      this.displayUrl = ''
    }
    this.window.webContents.send('ncc:state', this.getState())
  }
}

function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}
