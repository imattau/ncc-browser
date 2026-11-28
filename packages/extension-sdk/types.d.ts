/**
 * Types for the NCC extension surface. This is a deliberate subset of the Chrome
 * extension APIs plus the NCC-native `ncc.*` object.
 */

export interface NccManifest {
  manifest_version: 3
  name: string
  version: string
  description?: string
  author?: string
  permissions?: Array<
    | 'storage'
    | 'notifications'
    | 'contextMenus'
    | 'tabs'
    | 'scripting'
    | 'clipboardWrite'
    | 'nostr:pubkey'
    | 'nostr:profile'
    | 'nostr:sign'
    | 'nostr:nip04'
    | 'nostr:nip44'
    | 'blossom:group-image'
    | (string & {})
  >
  host_permissions?: string[]
  background?: { service_worker: string; type?: 'module' | 'classic' }
  content_scripts?: Array<{
    matches: string[]
    js?: string[]
    css?: string[]
    run_at?: 'document_start' | 'document_end' | 'document_idle'
    all_frames?: boolean
  }>
  action?: {
    default_title?: string
    default_popup?: string
    default_icon?: string | Record<string, string>
  }
  options_ui?: { page: string; open_in_tab?: boolean }
  options_page?: string
  icons?: Record<string, string>
  web_accessible_resources?: Array<string | { resources: string[]; matches: string[] }>
  ncc?: { min_version?: string; side_panel?: string }
}

export function defineManifest<T extends NccManifest>(manifest: T): T

export interface StorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
  get(
    keys: string | string[] | Record<string, unknown> | null,
    callback: (items: Record<string, unknown>) => void
  ): void
  set(items: Record<string, unknown>): Promise<void>
  set(items: Record<string, unknown>, callback: () => void): void
  remove(keys: string | string[]): Promise<void>
  remove(keys: string | string[], callback: () => void): void
  clear(): Promise<void>
  clear(callback: () => void): void
}

export interface StorageChange {
  oldValue?: unknown
  newValue?: unknown
}

export interface RuntimeMessageSender {
  id: string
  url: string
  tab?: Tab
}

export interface Tab {
  id: number
  index: number
  windowId: number
  active: boolean
  incognito: boolean
  url: string
  title: string
  status: 'complete'
}

export interface ChromeApi {
  runtime: {
    id: string
    lastError: { message: string } | null
    getURL(path: string): string
    getManifest(): NccManifest
    getPlatformInfo(): Promise<{ os: string; arch: string; nacl_arch: string }>
    sendMessage(message: unknown): Promise<unknown>
    sendMessage(message: unknown, callback: (response: unknown) => void): void
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: RuntimeMessageSender,
          sendResponse: (response?: unknown) => void
        ) => boolean | void | Promise<unknown>
      ): void
      removeListener(listener: (...args: never[]) => unknown): void
    }
    onInstalled: { addListener(listener: (details: { reason: string }) => void): void }
    onStartup: { addListener(listener: () => void): void }
  }
  storage: {
    local: StorageArea
    sync: StorageArea
    session: StorageArea
    onChanged: {
      addListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void
    }
  }
  tabs: {
    query(query: {
      active?: boolean
      url?: string | string[]
      currentWindow?: boolean
    }): Promise<Tab[]>
    query(
      query: { active?: boolean; url?: string | string[]; currentWindow?: boolean },
      callback: (tabs: Tab[]) => void
    ): void
    get(tabId: number): Promise<Tab | null>
    create(props: { url?: string; active?: boolean }): Promise<Tab | null>
    update(tabId: number, props: { url?: string; active?: boolean }): Promise<Tab>
    remove(tabId: number): Promise<void>
    sendMessage(tabId: number, message: unknown): Promise<unknown>
    sendMessage(tabId: number, message: unknown, callback: (response: unknown) => void): void
    reload(tabId: number): Promise<void>
  }
  scripting: {
    executeScript(injection: {
      target: { tabId: number }
      files: string[]
    }): Promise<Array<{ frameId: number; result: unknown }>>
  }
  action: {
    onClicked: { addListener(listener: (tab: Tab) => void): void }
  }
  contextMenus: {
    create(props: {
      id?: string | number
      title?: string
      contexts?: string[]
      documentUrlPatterns?: string[]
      type?: 'normal' | 'separator'
    }): Promise<string | number>
    remove(id: string | number): Promise<void>
    removeAll(): Promise<void>
    onClicked: {
      addListener(listener: (info: { menuItemId: string | number; pageUrl: string }) => void): void
    }
  }
  notifications: {
    create(id: string, options: { title: string; message: string; silent?: boolean }): Promise<string>
    create(options: { title: string; message: string; silent?: boolean }): Promise<string>
  }
  i18n: {
    getMessage(key: string, substitutions?: string | string[]): string
  }
  extension: {
    getURL(path: string): string
    getBackgroundPage(): null
  }
}

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface EventTemplate {
  kind: number
  created_at?: number
  tags?: string[][]
  content?: string
}

export interface NccApi {
  version: number
  nostr: {
    getPublicKey(): Promise<string>
    signEvent(event: EventTemplate): Promise<NostrEvent>
    getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
    requestEvents(relays: string[], filters: Array<Record<string, unknown>>): Promise<NostrEvent[]>
    publishEvent(relays: string[], event: NostrEvent): Promise<Record<string, { from: string; ok: boolean; message?: string }>>
    nip04: {
      encrypt(peer: string, plaintext: string): Promise<string>
      decrypt(peer: string, ciphertext: string): Promise<string>
    }
    nip44: {
      encrypt(peer: string, plaintext: string): Promise<string>
      decrypt(peer: string, ciphertext: string): Promise<string>
    }
  }
  runtime: {
    getURL(path: string): string
    closePanel(): Promise<void>
    setPanelWidth(width: number): Promise<void>
  }
  storage: { private: StorageArea }
}

declare global {
  const chrome: ChromeApi
  const browser: ChromeApi
  const ncc: NccApi
}
