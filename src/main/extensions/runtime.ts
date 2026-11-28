/**
 * Extension host. Owns background pages, message routing, storage events, toolbar
 * actions and the Nostr bridge. Content scripts are injected by the content preload;
 * this service only computes plans and answers bridge calls.
 */

import { BrowserWindow, Notification, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import {
  matchesAny,
  type ExtensionInstallResult,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionPage,
  type ExtensionPlanEntry,
  type ExtensionSender,
  type ExtensionStorageArea,
  type ExtensionsState
} from '@shared/extensions'
import type { TabKind } from '@shared/types'
import type { BrowserShell } from '../shell'
import type { Nip07Service } from '../signer/service'
import type { IdentityProvider } from '../signer/provider'
import type { RelayPool } from '../relay/pool'
import type { ExtensionRegistry } from './registry'
import { extensionPageUrl } from './protocol'
import type { ExtensionStorage, StorageChanges } from './storage'

export interface ExtensionServiceDeps {
  registry: ExtensionRegistry
  storage: ExtensionStorage
  host: BrowserShell
  nip07: () => Nip07Service | null
  identity: () => IdentityProvider | null
  relays: RelayPool
  preloadPath: string
  partition: string
  backgroundIdleMs?: number
  requestTimeoutMs?: number
}

interface BackgroundHost {
  window: BrowserWindow
  ready: Promise<void>
  idleTimer: NodeJS.Timeout | null
  active: number
}

interface Pending<T = unknown> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  webContentsId: number
}

interface ContextMenuItem {
  id: string | number
  title: string
  contexts: string[]
  documentUrlPatterns: string[]
  extensionId: string
}

const BACKGROUND_IDLE_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000

export class ExtensionService {
  private readonly backgrounds = new Map<string, BackgroundHost>()
  private readonly pending = new Map<string, Pending>()
  private readonly runs = new Map<string, Pending>()
  private readonly contextMenus = new Map<string, ContextMenuItem[]>()
  private readonly plans = new Map<number, Set<string>>()
  private readonly startedAt = Date.now()
  private readonly startupSent = new Set<string>()
  private readonly installedSent = new Set<string>()
  private readonly requestTimeoutMs: number
  private readonly backgroundIdleMs: number
  private disposed = false

  constructor(private readonly deps: ExtensionServiceDeps) {
    this.requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.backgroundIdleMs = deps.backgroundIdleMs ?? BACKGROUND_IDLE_MS
  }

  start(): void {
    this.deps.registry.autoInstallFromEnv(process.env.NCC_EXTENSION_DIR)
    this.notify()
  }

  state(): ExtensionsState {
    return this.deps.registry.state()
  }

  info(id: string): ExtensionInfo | null {
    return this.deps.registry.info(id)
  }

  installFolder(path: string): ExtensionInstallResult {
    return this.finishInstall(this.deps.registry.installFolder(path, { source: 'folder' }))
  }

  installZip(path: string): ExtensionInstallResult {
    return this.finishInstall(this.deps.registry.installZip(path))
  }

  remove(id: string): void {
    this.closeBackground(id)
    this.reloadTabsFor(id)
    this.deps.storage.removeExtension(id)
    this.deps.registry.remove(id)
    this.contextMenus.delete(id)
    this.notify()
  }

  setEnabled(id: string, enabled: boolean): void {
    if (!enabled) this.reloadTabsFor(id)
    this.deps.registry.setEnabled(id, enabled)
    if (!enabled) this.closeBackground(id)
    this.notify()
    if (enabled) this.reloadTabs(id)
  }

  setPrivateTabs(id: string, value: boolean): void {
    if (!value) this.reloadTabsFor(id)
    this.deps.registry.setPrivateTabs(id, value)
    this.notify()
  }

  setDeveloperMode(value: boolean): void {
    this.deps.registry.setDeveloperMode(value)
    this.notify()
  }

  reload(id: string): void {
    this.closeBackground(id)
    this.deps.registry.reload(id)
    this.notify()
    this.reloadTabs(id)
  }

  /** Compute the scripts a tab needs. Called synchronously from the preload. */
  planFor(webContentsId: number, frameUrl: string): ExtensionPlanEntry[] {
    const page = this.deps.host
      .extensionPages()
      .find((candidate) => candidate.id === webContentsId)
    if (!page) return []
    if (page.kind === 'tor') {
      this.plans.set(webContentsId, new Set())
      return []
    }
    const entries: ExtensionPlanEntry[] = []
    const infos = this.state().extensions.filter((entry) => entry.enabled)
    for (const [index, info] of infos.entries()) {
      const record = this.deps.registry.get(info.id)
      if (!record) continue
      if (page.kind === 'private' && !record.privateTabs) continue
      const matched = record.manifest.content_scripts.filter((script) =>
        matchesAny(script.matches, frameUrl)
      )
      const hostAllowed = matchesAny(record.manifest.host_permissions, frameUrl)
      if (matched.length === 0 && !hostAllowed) continue

      let code = ''
      let css = ''
      let runAt: ExtensionPlanEntry['runAt'] = 'document_idle'
      let first = true
      for (const script of matched) {
        if (first) {
          runAt = script.run_at
          first = false
        } else {
          runAt = earliest(runAt, script.run_at)
        }
        for (const path of script.js) {
          const value = this.deps.registry.readScript(info.id, path)
          if (value) code += `${code ? '\n;\n' : ''}${value}`
        }
        for (const path of script.css) css += this.deps.registry.readCss(info.id, path)
      }
      if (!code && !css && matched.length === 0 && hostAllowed) {
        // A host-permitted page needs a world for tabs.sendMessage and scripting,
        // but no packaged script runs until the extension asks for it.
        code = ''
      }
      entries.push({
        extensionId: info.id,
        worldId: 1000 + index,
        runAt,
        code,
        css,
        manifest: record.manifest
      })
    }
    this.plans.set(webContentsId, new Set(entries.map((entry) => entry.extensionId)))
    return entries
  }

  /** True when an extension may act on this tab frame. */
  allowed(extensionId: string, frameUrl: string, page: ExtensionPage | null): boolean {
    const record = this.deps.registry.get(extensionId)
    if (!record || !record.enabled) return false
    if (!page || page.kind === 'tor') return false
    if (page.kind === 'private' && !record.privateTabs) return false
    // Content scripts survive same-document navigation; trust the plan that was
    // actually injected rather than re-testing the current URL.
    if (this.plans.get(page.id)?.has(extensionId)) return true
    if (matchesAny(record.manifest.host_permissions, frameUrl)) return true
    return record.manifest.content_scripts.some((script) =>
      matchesAny(script.matches, frameUrl)
    )
  }

  manifest(id: string): ExtensionManifest | null {
    return this.deps.registry.get(id)?.manifest ?? null
  }

  pageForContents(id: number): ExtensionPage | null {
    return this.deps.host.extensionPages().find((page) => page.id === id) ?? null
  }

  pageForTabId(tabId: string): ExtensionPage | null {
    return this.deps.host.extensionPages().find((page) => page.tabId === tabId) ?? null
  }

  async invoke(
    extensionId: string,
    method: string,
    args: unknown[],
    sender: ExtensionSender
  ): Promise<unknown> {
    const record = this.deps.registry.get(extensionId)
    if (!record || !record.enabled) throw new Error('This extension is not installed')
    const manifest = record.manifest

    switch (method) {
      case 'ncc.panel.resize': {
        if (sender.from !== 'page') throw new Error('Only extension pages can resize a browser panel')
        this.deps.host.setExtensionPanelWidth(extensionId, Number(args[0]))
        return undefined
      }
      case 'ncc.panel.close': {
        if (sender.from !== 'page') throw new Error('Only extension pages can close a browser panel')
        if (sender.incognito) throw new Error('The companion panel is only available in a normal browser window')
        const sidePanel = this.deps.registry.get(extensionId)?.manifest.ncc.side_panel
        if (!sidePanel) throw new Error('This extension has no browser side panel')
        if (sender.extensionPagePath !== `/${sidePanel.replace(/^\/+/, '')}`) {
          throw new Error('Only the extension side panel can close its browser panel')
        }
        // Let Electron send the IPC response before destroying the calling page.
        setTimeout(() => this.deps.host.closeExtensionPanel(extensionId), 0)
        return undefined
      }
      case 'runtime.sendMessage':
        return this.sendRuntimeMessage(record.id, args[0], sender)
      case 'storage.get': {
        this.require(manifest, 'storage')
        const area = storageArea(args[0])
        return this.deps.storage.get(extensionId, area, args[1])
      }
      case 'storage.set': {
        this.require(manifest, 'storage')
        const area = storageArea(args[0])
        const result = this.deps.storage.set(extensionId, area, args[1])
        if (result.error) throw new Error(result.error)
        this.broadcastStorage(extensionId, result.changes, area)
        return undefined
      }
      case 'storage.remove': {
        this.require(manifest, 'storage')
        const area = storageArea(args[0])
        const result = this.deps.storage.remove(extensionId, area, args[1])
        this.broadcastStorage(extensionId, result.changes, area)
        return undefined
      }
      case 'storage.clear': {
        this.require(manifest, 'storage')
        const area = storageArea(args[0])
        const result = this.deps.storage.clear(extensionId, area)
        this.broadcastStorage(extensionId, result.changes, area)
        return undefined
      }
      case 'tabs.query':
        this.require(manifest, 'tabs')
        return this.queryTabs(record.id, args[0])
      case 'tabs.get': {
        this.require(manifest, 'tabs')
        const page = this.tabById(record.id, Number(args[0]))
        return page ? tabInfo(page) : null
      }
      case 'tabs.sendMessage':
        return this.sendTabMessage(record.id, args[0], args[1], sender)
      case 'tabs.create': {
        this.require(manifest, 'tabs')
        const props = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : {}
        const url = typeof props.url === 'string' ? props.url : undefined
        if (url && !/^(https?|ncc):\/\//i.test(url)) throw new Error('Unsupported tab URL')
        const tabId = this.deps.host.newTab(url)
        const page = this.deps.host.extensionPages().find((entry) => entry.tabId === tabId)
        return page ? tabInfo(page) : null
      }
      case 'tabs.update': {
        this.require(manifest, 'tabs')
        const page = this.tabById(record.id, Number(args[0]))
        if (!page) throw new Error('No such tab')
        const props = args[1] && typeof args[1] === 'object' ? (args[1] as Record<string, unknown>) : {}
        if (typeof props.url === 'string') {
          if (!/^(https?|ncc):\/\//i.test(props.url)) throw new Error('Unsupported tab URL')
          this.deps.host.navigateTab(page.tabId, props.url)
        }
        if (props.active === true) this.deps.host.selectTab(page.tabId)
        return tabInfo(page)
      }
      case 'tabs.remove': {
        this.require(manifest, 'tabs')
        const page = this.tabById(record.id, Number(args[0]))
        if (page) this.deps.host.closeTab(page.tabId)
        return undefined
      }
      case 'tabs.reload': {
        this.require(manifest, 'tabs')
        const page = this.tabById(record.id, Number(args[0]))
        if (!page) throw new Error('No such tab')
        this.deps.host.reloadTab(page.tabId)
        return undefined
      }
      case 'scripting.executeScript':
        return this.executeScript(record.id, args[0], sender)
      case 'contextMenus.create':
        this.require(manifest, 'contextMenus')
        return this.createContextMenu(record.id, args[0])
      case 'contextMenus.remove':
        this.require(manifest, 'contextMenus')
        this.removeContextMenu(record.id, args[0])
        return undefined
      case 'contextMenus.removeAll':
        this.require(manifest, 'contextMenus')
        this.contextMenus.delete(record.id)
        return undefined
      case 'notifications.create':
        this.require(manifest, 'notifications')
        return this.showNotification(record, args[0], args[1])
      case 'nostr.getPublicKey':
        this.require(manifest, 'nostr:pubkey')
        return this.nostr().getPublicKey(this.caller(record, sender))
      case 'nostr.signEvent':
        this.require(manifest, 'nostr:sign')
        return this.nostr().signEvent(this.caller(record, sender), args[0])
      case 'nostr.getRelays':
        this.require(manifest, 'nostr:pubkey')
        return this.nostr().getRelays()
      case 'nostr.requestEvents': {
        const relays = this.allowedRelays(record.manifest, args[0])
        const filters = Array.isArray(args[1]) ? args[1] : [args[1]]
        if (!filters.length || filters.some((filter) => !filter || typeof filter !== 'object' || Array.isArray(filter))) throw new Error('Invalid Nostr relay filters')
        return Promise.all(relays.flatMap((relay) => filters.map((filter) => this.deps.relays.query([relay], filter as never))))
          .then((results) => [...new Map(results.flat().map((event) => [event.id, event])).values()])
      }
      case 'nostr.publishEvent': {
        const relays = this.allowedRelays(record.manifest, args[0])
        const event = args[1]
        if (!event || typeof event !== 'object' || !Number.isInteger((event as { kind?: unknown }).kind) || typeof (event as { id?: unknown }).id !== 'string') throw new Error('Invalid signed Nostr event')
        const identity = this.deps.identity()
        const expectedPubkey = identity ? await identity.getPublicKey() : null
        const onauth = identity && expectedPubkey
          ? async (template: EventTemplate): Promise<Event> => {
              const signed = await identity.signEvent(template)
              if (!verifyEvent(signed) || signed.pubkey !== expectedPubkey) throw new Error('The active signer returned an invalid relay authentication event')
              return signed
            }
          : undefined
        return Promise.allSettled(relays.map((relay) => this.deps.relays.publishWithAuth(relay, event as never, onauth)))
          .then((results) => Object.fromEntries(results.map((result, index) => [relays[index], result.status === 'fulfilled' ? { from: relays[index], ok: true, message: result.value } : { from: relays[index], ok: false, message: errorMessage(result.reason) }])))
      }
      case 'nostr.nip04Encrypt':
        this.require(manifest, 'nostr:nip04')
        return this.nostr().nip04Encrypt(this.caller(record, sender), String(args[0]), args[1])
      case 'nostr.nip04Decrypt':
        this.require(manifest, 'nostr:nip04')
        return this.nostr().nip04Decrypt(this.caller(record, sender), String(args[0]), args[1])
      case 'nostr.nip44Encrypt':
        this.require(manifest, 'nostr:nip44')
        return this.nostr().nip44Encrypt(this.caller(record, sender), String(args[0]), args[1])
      case 'nostr.nip44Decrypt':
        this.require(manifest, 'nostr:nip44')
        return this.nostr().nip44Decrypt(this.caller(record, sender), String(args[0]), args[1])
      default:
        throw new Error(`Unknown extension API: ${method}`)
    }
  }

  async clickAction(id: string, anchor: { top: number; left: number }): Promise<void> {
    const record = this.deps.registry.get(id)
    if (!record?.enabled || !record.manifest.action) return
    if (record.manifest.ncc.side_panel) {
      this.deps.host.toggleExtensionPanel(record.id, record.manifest.ncc.side_panel)
      return
    }
    if (record.manifest.action.default_popup) {
      this.openPopup(record.id, record.manifest.action.default_popup, anchor)
      return
    }
    const page = this.activePage()
    await this.fireBackground(record.id, 'action.clicked', { tab: page ? tabInfo(page) : null })
  }

  openOptions(id: string): void {
    const record = this.deps.registry.get(id)
    const page = record?.manifest.options_page
    if (!record || !page) return
    const win = new BrowserWindow({
      width: 780,
      height: 640,
      show: false,
      parent: this.deps.host.window,
      autoHideMenuBar: true,
      title: `${record.manifest.name} options`,
      backgroundColor: '#111318',
      webPreferences: this.pagePreferences()
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|ncc):\/\//i.test(url)) this.deps.host.newTab(url)
      return { action: 'deny' }
    })
    win.once('ready-to-show', () => win.show())
    void win.loadURL(extensionPageUrl(id, page))
  }

  contextMenuItems(url: string): Array<{ label: string; click: () => void }> {
    const items: Array<{ label: string; click: () => void }> = []
    const page = this.activePage()
    if (page?.kind === 'tor') return items
    for (const [extensionId, list] of this.contextMenus) {
      const record = this.deps.registry.get(extensionId)
      if (!record?.enabled) continue
      if (page && !this.allowed(extensionId, url, page)) continue
      for (const item of list) {
        if (!item.contexts.includes('all') && !item.contexts.includes('page')) continue
        if (item.documentUrlPatterns.length && !matchesAny(item.documentUrlPatterns, url)) {
          continue
        }
        items.push({
          label: item.title,
          click: () => {
            void this.fireBackground(extensionId, 'contextMenus.clicked', {
              menuItemId: item.id,
              pageUrl: url,
              tab: page ? tabInfo(page) : null
            })
          }
        })
      }
    }
    return items
  }

  onSessionReleased(kind: TabKind): void {
    if (kind === 'private') this.deps.storage.clearPrivate()
  }

  handleEventResult(webContentsId: number, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const value = payload as { requestId?: unknown; result?: unknown; error?: unknown }
    if (typeof value.requestId !== 'string') return
    const pending = this.pending.get(value.requestId) ?? this.runs.get(value.requestId)
    if (!pending || pending.webContentsId !== webContentsId) return
    this.pending.delete(value.requestId)
    this.runs.delete(value.requestId)
    clearTimeout(pending.timer)
    if (typeof value.error === 'string') pending.reject(new Error(value.error))
    else pending.resolve(value.result)
  }

  dispose(): void {
    this.disposed = true
    for (const id of [...this.backgrounds.keys()]) this.closeBackground(id)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The extension runtime stopped'))
    }
    this.pending.clear()
    for (const pending of this.runs.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The extension runtime stopped'))
    }
    this.runs.clear()
  }

  private finishInstall(result: ExtensionInstallResult): ExtensionInstallResult {
    if (!result.ok || !result.extension) {
      if (result.error) console.warn('[extensions] install failed:', result.error)
      return result
    }
    this.notify()
    this.reloadTabs(result.extension.id)
    return result
  }

  private notify(): void {
    this.deps.host.sendToChrome('ncc:extensions-state', this.state())
  }

  private activePage(): ExtensionPage | null {
    return this.deps.host.extensionPages().find((page) => page.active) ?? null
  }

  private require(manifest: ExtensionManifest, permission: string): void {
    if (!manifest.permissions.includes(permission)) {
      throw new Error(`The extension does not have the "${permission}" permission`)
    }
  }

  private nostr(): Nip07Service {
    const service = this.deps.nip07()
    if (!service) throw new Error('The signer is not ready')
    return service
  }

  private caller(record: { id: string; manifest: ExtensionManifest }, sender: ExtensionSender) {
    const kind = sender.tab?.kind ?? 'normal'
    return {
      origin: `extension:${record.id}`,
      label: record.manifest.name,
      kind,
      ephemeral: kind !== 'normal',
      torTab: false
    }
  }

  private allowedRelays(manifest: ExtensionManifest, input: unknown): string[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 12) throw new Error('Choose between one and twelve permitted relays')
    return [...new Set(input.map((value) => {
      if (typeof value !== 'string') throw new Error('Invalid relay URL')
      const url = new URL(value)
      if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('Only secure WebSocket relays are allowed')
      const matchUrl = `https://${url.host}/`
      if (!matchesAny(manifest.host_permissions, matchUrl)) throw new Error(`The extension has no permission for relay ${url.host}`)
      return url.toString()
    }))]
  }

  private queryTabs(extensionId: string, query: unknown): unknown[] {
    const record = this.deps.registry.get(extensionId)
    if (!record) return []
    const value = query && typeof query === 'object' ? (query as Record<string, unknown>) : {}
    const patterns = Array.isArray(value.url)
      ? value.url.filter((entry): entry is string => typeof entry === 'string')
      : typeof value.url === 'string'
        ? [value.url]
        : []
    return this.deps.host
      .extensionPages()
      .filter((page) => page.kind !== 'tor')
      .filter((page) => page.kind !== 'private' || record.privateTabs)
      .filter((page) => (value.active === true ? page.active : true))
      .filter((page) => (patterns.length ? matchesAny(patterns, page.url) : true))
      .map(tabInfo)
  }

  private tabById(extensionId: string, tabId: number): ExtensionPage | null {
    const record = this.deps.registry.get(extensionId)
    if (!record) return null
    const page = this.pageForContents(tabId)
    if (!page || page.kind === 'tor') return null
    if (page.kind === 'private' && !record.privateTabs) return null
    if (!this.allowed(extensionId, page.url, page)) return null
    return page
  }

  private async sendRuntimeMessage(
    extensionId: string,
    message: unknown,
    sender: ExtensionSender
  ): Promise<unknown> {
    if (sender.from === 'background') {
      const pages = this.deps.host
        .extensionPages()
        .filter((page) => page.kind !== 'tor')
        .filter((page) => this.allowed(extensionId, page.url, page))
      for (const page of pages) {
        if (!this.hasWorld(extensionId, page)) continue
        const result = await this.sendEventToContents(page, extensionId, 'runtime.message', {
          message,
          sender: { id: extensionId, url: sender.tab?.url ?? '' }
        })
        if (result !== undefined) return result
      }
      return undefined
    }
    return this.sendEventToBackground(extensionId, 'runtime.message', {
      message,
      sender: {
        id: extensionId,
        tab: sender.tab ? tabInfo(sender.tab) : undefined,
        url: sender.tab?.url ?? ''
      }
    })
  }

  private async sendTabMessage(
    extensionId: string,
    tabId: unknown,
    message: unknown,
    sender: ExtensionSender
  ): Promise<unknown> {
    this.require(this.deps.registry.get(extensionId)!.manifest, 'tabs')
    const page = this.tabById(extensionId, Number(tabId))
    if (!page) throw new Error('No such tab')
    if (!this.hasWorld(extensionId, page)) return undefined
    return this.sendEventToContents(page, extensionId, 'runtime.message', {
      message,
      sender: { id: extensionId, url: sender.tab?.url ?? '' }
    })
  }

  private async executeScript(
    extensionId: string,
    injection: unknown,
    sender: ExtensionSender
  ): Promise<unknown> {
    const record = this.deps.registry.get(extensionId)
    if (!record) throw new Error('This extension is not installed')
    this.require(record.manifest, 'scripting')
    const value = injection && typeof injection === 'object' ? (injection as Record<string, unknown>) : {}
    const target = value.target && typeof value.target === 'object' ? (value.target as Record<string, unknown>) : {}
    const tabId = Number(target.tabId)
    const page = this.tabById(extensionId, tabId)
    if (!page) throw new Error('No such tab')
    const files = Array.isArray(value.files)
      ? value.files.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (files.length === 0) throw new Error('Only files-based executeScript is supported')
    let code = ''
    for (const file of files) {
      const script = this.deps.registry.readScript(extensionId, file)
      if (!script) throw new Error(`Script not found: ${file}`)
      code += `${code ? '\n;\n' : ''}${script}`
    }
    const result = await this.runInContents(page, extensionId, code)
    return [{ frameId: 0, result }]
  }

  private createContextMenu(extensionId: string, props: unknown): string | number {
    const value = props && typeof props === 'object' ? (props as Record<string, unknown>) : {}
    const title = typeof value.title === 'string' ? value.title.slice(0, 200) : ''
    if (!title && value.type !== 'separator') throw new Error('contextMenus.create needs a title')
    const id =
      typeof value.id === 'string' || typeof value.id === 'number'
        ? value.id
        : `${extensionId}:${randomUUID()}`
    const contexts = Array.isArray(value.contexts)
      ? value.contexts.filter((entry): entry is string => typeof entry === 'string')
      : ['page']
    const documentUrlPatterns = Array.isArray(value.documentUrlPatterns)
      ? value.documentUrlPatterns.filter(
          (entry): entry is string => typeof entry === 'string'
        )
      : []
    const list = this.contextMenus.get(extensionId) ?? []
    const item: ContextMenuItem = {
      id,
      title,
      contexts,
      documentUrlPatterns,
      extensionId
    }
    const index = list.findIndex((entry) => entry.id === id)
    if (index >= 0) list[index] = item
    else list.push(item)
    this.contextMenus.set(extensionId, list)
    return id
  }

  private removeContextMenu(extensionId: string, id: unknown): void {
    const list = this.contextMenus.get(extensionId)
    if (!list) return
    this.contextMenus.set(
      extensionId,
      list.filter((entry) => entry.id !== id)
    )
  }

  private showNotification(record: { id: string; manifest: ExtensionManifest }, title: unknown, options: unknown): string {
    if (!Notification.isSupported()) return ''
    const value = options && typeof options === 'object' ? (options as Record<string, unknown>) : {}
    const id = typeof title === 'string' && title ? title : randomUUID()
    const notification = new Notification({
      title: typeof value.title === 'string' ? value.title : record.manifest.name,
      body: typeof value.message === 'string' ? value.message : '',
      silent: value.silent === true
    })
    notification.show()
    return id
  }

  private async fireBackground(extensionId: string, kind: string, data: unknown): Promise<void> {
    try {
      await this.sendEventToBackground(extensionId, kind, data)
    } catch {
      // Fire-and-forget events must not surface as unhandled rejections.
    }
  }

  private async sendEventToBackground(
    extensionId: string,
    kind: string,
    data: unknown
  ): Promise<unknown> {
    const host = await this.ensureBackground(extensionId)
    if (!host) return undefined
    const requestId = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The extension background did not respond'))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId: host.window.webContents.id
      })
    })
    host.active += 1
    host.window.webContents.send('ext:event', { requestId, kind, data })
    try {
      return await result
    } finally {
      host.active -= 1
      this.scheduleIdle(extensionId, host)
    }
  }

  private async sendEventToContents(
    page: ExtensionPage,
    extensionId: string,
    kind: string,
    data: unknown
  ): Promise<unknown> {
    const requestId = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The page did not respond'))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { resolve, reject, timer, webContentsId: page.id })
    })
    const sent = this.deps.host.sendToContent(page.tabId, 'ext:event', {
      requestId,
      extensionId,
      kind,
      data
    })
    if (!sent) {
      const pending = this.pending.get(requestId)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(requestId)
      throw new Error('The page is no longer available')
    }
    return result
  }

  private async runInContents(
    page: ExtensionPage,
    extensionId: string,
    code: string
  ): Promise<unknown> {
    const requestId = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runs.delete(requestId)
        reject(new Error('The page did not run the script'))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.runs.set(requestId, { resolve, reject, timer, webContentsId: page.id })
    })
    const sent = this.deps.host.sendToContent(page.tabId, 'ext:run', {
      requestId,
      extensionId,
      code
    })
    if (!sent) {
      const pending = this.runs.get(requestId)
      if (pending) clearTimeout(pending.timer)
      this.runs.delete(requestId)
      throw new Error('The page is no longer available')
    }
    return result
  }

  private broadcastStorage(
    extensionId: string,
    changes: StorageChanges,
    area: ExtensionStorageArea
  ): void {
    if (Object.keys(changes).length === 0) return
    void this.fireBackground(extensionId, 'storage.changed', { changes, area })
    for (const page of this.deps.host.extensionPages()) {
      if (!this.allowed(extensionId, page.url, page)) continue
      if (!this.hasWorld(extensionId, page)) continue
      this.deps.host.sendToContent(page.tabId, 'ext:event', {
        extensionId,
        kind: 'storage.changed',
        data: { changes, area }
      })
    }
  }

  private hasWorld(extensionId: string, page: ExtensionPage): boolean {
    return this.planFor(page.id, page.url).some((entry) => entry.extensionId === extensionId)
  }

  private async ensureBackground(extensionId: string): Promise<BackgroundHost | null> {
    if (this.disposed) return null
    const existing = this.backgrounds.get(extensionId)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer)
        existing.idleTimer = null
      }
      await existing.ready
      return existing
    }
    const record = this.deps.registry.get(extensionId)
    if (!record || !record.enabled || !record.manifest.background) return null

    const win = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      skipTaskbar: true,
      webPreferences: {
        ...this.pagePreferences(),
        backgroundThrottling: false
      }
    })
    const host: BackgroundHost = {
      window: win,
      ready: Promise.resolve(),
      idleTimer: null,
      active: 0
    }
    host.ready = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', (_event, code, description) =>
        reject(new Error(`Background page failed to load (${code} ${description})`))
      )
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|ncc):\/\//i.test(url)) this.deps.host.newTab(url)
      return { action: 'deny' }
    })
    win.on('closed', () => {
      const current = this.backgrounds.get(extensionId)
      if (current?.window === win) this.backgrounds.delete(extensionId)
    })
    win.webContents.on('render-process-gone', () => {
      win.destroy()
    })
    this.backgrounds.set(extensionId, host)
    void win.loadURL(extensionPageUrl(extensionId, '__ncc_background__.html')).catch(() => undefined)
    try {
      await host.ready
    } catch (error) {
      this.backgrounds.delete(extensionId)
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
    const recordNow = this.deps.registry.get(extensionId)
    if (recordNow && !this.installedSent.has(extensionId) && recordNow.installedAt >= this.startedAt) {
      this.installedSent.add(extensionId)
      await this.fireBackgroundEventRaw(host, 'runtime.installed', {
        reason: 'install',
        previousVersion: null
      })
    } else if (!this.startupSent.has(extensionId)) {
      this.startupSent.add(extensionId)
      await this.fireBackgroundEventRaw(host, 'runtime.startup', {})
    }
    return host
  }

  private async fireBackgroundEventRaw(
    host: BackgroundHost,
    kind: string,
    data: unknown
  ): Promise<void> {
    const requestId = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(undefined)
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId: host.window.webContents.id
      })
    })
    host.window.webContents.send('ext:event', { requestId, kind, data })
    await result
  }

  private scheduleIdle(extensionId: string, host: BackgroundHost): void {
    if (host.idleTimer) clearTimeout(host.idleTimer)
    host.idleTimer = setTimeout(() => {
      if (host.active > 0) return
      this.closeBackground(extensionId)
    }, this.backgroundIdleMs)
    host.idleTimer.unref?.()
  }

  private closeBackground(extensionId: string): void {
    const host = this.backgrounds.get(extensionId)
    if (!host) return
    this.backgrounds.delete(extensionId)
    if (host.idleTimer) clearTimeout(host.idleTimer)
    if (!host.window.isDestroyed()) host.window.destroy()
  }

  private reloadTabs(extensionId: string): void {
    const record = this.deps.registry.get(extensionId)
    if (!record?.enabled) return
    for (const page of this.deps.host.extensionPages()) {
      if (!this.allowed(extensionId, page.url, page)) continue
      if (page.url && !page.url.startsWith('about:')) this.deps.host.reloadTab(page.tabId)
    }
  }

  /** Reload every tab this extension could ever touch, including revoked private tabs. */
  private reloadTabsFor(extensionId: string): void {
    const record = this.deps.registry.get(extensionId)
    if (!record) return
    for (const page of this.deps.host.extensionPages()) {
      if (page.kind === 'tor') continue
      if (!page.url || page.url.startsWith('about:')) continue
      const matches =
        matchesAny(record.manifest.host_permissions, page.url) ||
        record.manifest.content_scripts.some((script) => matchesAny(script.matches, page.url))
      if (matches) this.deps.host.reloadTab(page.tabId)
    }
  }

  private pagePreferences(): Electron.WebPreferences {
    return {
      preload: this.deps.preloadPath,
      partition: this.deps.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      safeDialogs: true
    }
  }

  private openPopup(
    extensionId: string,
    page: string,
    anchor: { top: number; left: number }
  ): void {
    const width = 380
    const height = 540
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      parent: this.deps.host.window,
      alwaysOnTop: true,
      backgroundColor: '#111318',
      webPreferences: this.pagePreferences()
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    const bounds = this.deps.host.window.getContentBounds()
    const work = screen.getDisplayMatching(bounds).workArea
    const x = Math.min(
      Math.max(work.x, bounds.x + anchor.left),
      work.x + work.width - width
    )
    const y = Math.min(
      Math.max(work.y, bounds.y + anchor.top),
      work.y + work.height - height
    )
    win.setPosition(Math.round(x), Math.round(y))
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|ncc):\/\//i.test(url)) this.deps.host.newTab(url)
      return { action: 'deny' }
    })
    win.once('ready-to-show', () => win.show())
    win.on('blur', () => {
      if (!win.isDestroyed()) win.close()
    })
    void win.loadURL(extensionPageUrl(extensionId, page))
  }
}

function storageArea(value: unknown): ExtensionStorageArea {
  if (value === 'local' || value === 'sync' || value === 'session' || value === 'private') {
    return value
  }
  return 'local'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function earliest(
  a: ExtensionPlanEntry['runAt'],
  b: ExtensionPlanEntry['runAt']
): ExtensionPlanEntry['runAt'] {
  const order = { document_start: 0, document_end: 1, document_idle: 2 }
  return order[a] <= order[b] ? a : b
}

function tabInfo(page: ExtensionPage): Record<string, unknown> {
  return {
    id: page.id,
    index: 0,
    windowId: 1,
    active: page.active,
    incognito: page.incognito,
    url: page.url,
    title: page.title,
    status: 'complete'
  }
}

