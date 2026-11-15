import { contextBridge, ipcRenderer } from 'electron'
import type { NccApi } from '@shared/api'
import type { AutomationState } from '@shared/automation'
import type { ExtensionsState } from '@shared/extensions'
import { readAppearanceBootArgument } from '@shared/appearance'
import {
  DEFAULT_APPEARANCE,
  type AppConfig,
  type Bookmark,
  type DownloadNotice,
  type NavState,
  type PasswordContext,
  type PasswordSaveRequest,
  type PasswordToast,
  type PasswordVaultStatus,
  type SignerRequest
} from '@shared/types'

const api: NccApi = {
  initialAppearance: readAppearanceBootArgument(process.argv) ?? DEFAULT_APPEARANCE,
  navigate: (input) => ipcRenderer.invoke('ncc:navigate', input),
  back: () => ipcRenderer.invoke('ncc:back'),
  forward: () => ipcRenderer.invoke('ncc:forward'),
  reload: () => ipcRenderer.invoke('ncc:reload'),
  forceReload: () => ipcRenderer.invoke('ncc:force-reload'),
  stop: () => ipcRenderer.invoke('ncc:stop'),
  toggleTor: () => ipcRenderer.invoke('ncc:toggle-tor'),
  insecureChoice: (choice) => ipcRenderer.invoke('ncc:insecure-choice', choice),
  newTab: (input) => ipcRenderer.invoke('ncc:new-tab', input),
  newPrivateTab: (input) => ipcRenderer.invoke('ncc:new-private-tab', input),
  newTorTab: (input) => ipcRenderer.invoke('ncc:new-tor-tab', input),
  closeTab: (id) => ipcRenderer.invoke('ncc:close-tab', id),
  selectTab: (id) => ipcRenderer.invoke('ncc:select-tab', id),
  moveTab: (id, toIndex) => ipcRenderer.invoke('ncc:move-tab', { id, toIndex }),
  duplicateTab: (id) => ipcRenderer.invoke('ncc:duplicate-tab', id),
  reloadTab: (id) => ipcRenderer.invoke('ncc:reload-tab', id),
  toggleMute: (id) => ipcRenderer.invoke('ncc:toggle-mute', id),
  closeOtherTabs: (id) => ipcRenderer.invoke('ncc:close-other-tabs', id),
  closeTabsToRight: (id) => ipcRenderer.invoke('ncc:close-tabs-right', id),
  showTabMenu: (id) => ipcRenderer.invoke('ncc:tab-menu', id),
  tabHistory: (id) => ipcRenderer.invoke('ncc:tab-history', id),
  goToHistoryIndex: (index) => ipcRenderer.invoke('ncc:go-history-index', index),
  clearHistory: () => ipcRenderer.invoke('ncc:clear-history'),
  showHistoryMenu: (direction) => ipcRenderer.invoke('ncc:history-menu', direction),
  getState: () => ipcRenderer.invoke('ncc:get-state'),
  getConfig: () => ipcRenderer.invoke('ncc:get-config'),
  bookmarks: () => ipcRenderer.invoke('ncc:bookmarks'),
  toggleBookmark: () => ipcRenderer.invoke('ncc:toggle-bookmark'),
  removeBookmark: (url) => ipcRenderer.invoke('ncc:remove-bookmark', url),
  downloads: () => ipcRenderer.invoke('ncc:get-downloads'),
  cancelDownload: (id) => ipcRenderer.invoke('ncc:cancel-download', id),
  revealDownload: (id) => ipcRenderer.invoke('ncc:reveal-download', id),
  clearDownloads: () => ipcRenderer.invoke('ncc:clear-downloads'),
  minimizeWindow: () => ipcRenderer.invoke('ncc:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('ncc:window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('ncc:window-close'),
  setRelays: (relays) => ipcRenderer.invoke('ncc:set-relays', relays),
  resolveRelayLocator: (input) => ipcRenderer.invoke('ncc:resolve-relay-locator', input),
  setGossip: (value) => ipcRenderer.invoke('ncc:set-gossip', value),
  setAnchorRequired: (value) => ipcRenderer.invoke('ncc:set-anchor-required', value),
  setPreferTor: (value) => ipcRenderer.invoke('ncc:set-prefer-tor', value),
  setTorMode: (mode) => ipcRenderer.invoke('ncc:set-tor-mode', mode),
  setTorSocks: (socks) => ipcRenderer.invoke('ncc:set-tor-socks', socks),
  setTorConfig: (config) => ipcRenderer.invoke('ncc:set-tor-config', config),
  setSecurityConfig: (config) => ipcRenderer.invoke('ncc:set-security-config', config),
  removeHttpException: (key) => ipcRenderer.invoke('ncc:remove-http-exception', key),
  clearHttpExceptions: () => ipcRenderer.invoke('ncc:clear-http-exceptions'),
  omniboxSuggest: (input) => ipcRenderer.invoke('ncc:omnibox-suggest', input),
  clearBrowsingHistory: () => ipcRenderer.invoke('ncc:clear-browsing-history'),
  siteData: () => ipcRenderer.invoke('ncc:site-data'),
  clearSiteData: (options) => ipcRenderer.invoke('ncc:clear-site-data', options),
  cacheInfo: () => ipcRenderer.invoke('ncc:cache-info'),
  clearCache: () => ipcRenderer.invoke('ncc:clear-cache'),
  reResolveSite: () => ipcRenderer.invoke('ncc:re-resolve-site'),
  setSearchConfig: (config) => ipcRenderer.invoke('ncc:set-search-config', config),
  setAppearance: (appearance) => ipcRenderer.invoke('ncc:set-appearance', appearance),
  passwordsStatus: () => ipcRenderer.invoke('ncc:password-status'),
  passwordsContext: () => ipcRenderer.invoke('ncc:password-context'),
  passwordsUnlock: () => ipcRenderer.invoke('ncc:password-unlock'),
  passwordsLock: () => ipcRenderer.invoke('ncc:password-lock'),
  passwordsList: () => ipcRenderer.invoke('ncc:password-list'),
  passwordsEntry: (id) => ipcRenderer.invoke('ncc:password-entry', id),
  passwordsReveal: (id) => ipcRenderer.invoke('ncc:password-reveal', id),
  passwordsTotp: (id) => ipcRenderer.invoke('ncc:password-totp', id),
  passwordsCopy: (id, field) => ipcRenderer.invoke('ncc:password-copy', id, field),
  passwordsGenerate: (options) => ipcRenderer.invoke('ncc:password-generate', options),
  passwordsSave: (entry) => ipcRenderer.invoke('ncc:password-save', entry),
  passwordsRemove: (id) => ipcRenderer.invoke('ncc:password-remove', id),
  passwordsSync: () => ipcRenderer.invoke('ncc:password-sync'),
  passwordsFill: (id) => ipcRenderer.invoke('ncc:password-fill', id),
  passwordsSetConfig: (config) => ipcRenderer.invoke('ncc:password-config', config),
  passwordsRemoveNever: (origin) => ipcRenderer.invoke('ncc:password-remove-never', origin),
  passwordsRespond: (id, action) => ipcRenderer.invoke('ncc:password-respond', id, action),
  passwordsImportOpen: () => ipcRenderer.invoke('ncc:password-import-open'),
  passwordsImportCommit: (id, mode) => ipcRenderer.invoke('ncc:password-import-commit', id, mode),
  passwordsExport: (format) => ipcRenderer.invoke('ncc:password-export', format),
  automationState: () => ipcRenderer.invoke('ncc:automation-state'),
  automationSetEnabled: (value) => ipcRenderer.invoke('ncc:automation-set-enabled', value),
  automationRegenerate: () => ipcRenderer.invoke('ncc:automation-regenerate'),
  automationRevoke: (site) => ipcRenderer.invoke('ncc:automation-revoke', site),
  automationCopyCommand: () => ipcRenderer.invoke('ncc:automation-copy-command'),
  onAutomation: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AutomationState): void =>
      listener(state)
    ipcRenderer.on('ncc:automation-state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:automation-state', handler)
    }
  },
  extensionsState: () => ipcRenderer.invoke('ncc:extensions-state'),
  extensionsSetDeveloper: (value) => ipcRenderer.invoke('ncc:extensions-set-developer', value),
  extensionsInstall: (kind) => ipcRenderer.invoke('ncc:extensions-install', kind),
  extensionsRemove: (id) => ipcRenderer.invoke('ncc:extensions-remove', id),
  extensionsSetEnabled: (id, value) => ipcRenderer.invoke('ncc:extensions-set-enabled', id, value),
  extensionsSetPrivate: (id, value) => ipcRenderer.invoke('ncc:extensions-set-private', id, value),
  extensionsReload: (id) => ipcRenderer.invoke('ncc:extensions-reload', id),
  extensionsOpenOptions: (id) => ipcRenderer.invoke('ncc:extensions-open-options', id),
  extensionsReveal: (id) => ipcRenderer.invoke('ncc:extensions-reveal', id),
  extensionsAction: (id, anchor) => ipcRenderer.invoke('ncc:extensions-action', id, anchor),
  torStatus: () => ipcRenderer.invoke('ncc:tor-status'),
  appInfo: () => ipcRenderer.invoke('ncc:app-info'),
  torTest: () => ipcRenderer.invoke('ncc:tor-test'),
  torRestart: () => ipcRenderer.invoke('ncc:tor-restart'),
  identity: () => ipcRenderer.invoke('ncc:identity-status'),
  importIdentity: (secret) => ipcRenderer.invoke('ncc:identity-import', secret),
  generateIdentity: () => ipcRenderer.invoke('ncc:identity-generate'),
  removeIdentity: () => ipcRenderer.invoke('ncc:identity-remove'),
  identityConnectBunker: (url) => ipcRenderer.invoke('ncc:identity-connect-bunker', url),
  identityDisconnect: () => ipcRenderer.invoke('ncc:identity-disconnect'),
  signerPermissions: () => ipcRenderer.invoke('ncc:signer-permissions'),
  revokePermission: (origin) => ipcRenderer.invoke('ncc:revoke-permission', origin),
  pendingSignerRequests: () => ipcRenderer.invoke('ncc:signer-pending'),
  signerOrigin: (url) => ipcRenderer.invoke('ncc:signer-origin', url),
  setSignerTrust: (url, trusted) => ipcRenderer.invoke('ncc:signer-trust', { url, trusted }),
  respondToSigner: (id, allow, remember) =>
    ipcRenderer.invoke('ncc:signer-response', { id, allow, remember }),
  runCommand: (command) => ipcRenderer.invoke('ncc:command', command),
  setOverlay: (reason, active) => ipcRenderer.invoke('ncc:set-overlay', { reason, active }),
  onOpenSettings: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { section: string }): void =>
      listener(payload)
    ipcRenderer.on('ncc:open-settings', handler)
    return () => {
      ipcRenderer.removeListener('ncc:open-settings', handler)
    }
  },
  onCloseMenu: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:close-menu', handler)
    return () => {
      ipcRenderer.removeListener('ncc:close-menu', handler)
    }
  },
  onOpenHistory: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:open-history', handler)
    return () => {
      ipcRenderer.removeListener('ncc:open-history', handler)
    }
  },
  onOpenDownloads: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:open-downloads', handler)
    return () => {
      ipcRenderer.removeListener('ncc:open-downloads', handler)
    }
  },
  onBookmarks: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, bookmarks: Bookmark[]): void =>
      listener(bookmarks)
    ipcRenderer.on('ncc:bookmarks', handler)
    return () => {
      ipcRenderer.removeListener('ncc:bookmarks', handler)
    }
  },
  onSignerRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: SignerRequest): void =>
      listener(request)
    ipcRenderer.on('ncc:signer-request', handler)
    return () => {
      ipcRenderer.removeListener('ncc:signer-request', handler)
    }
  },
  onSignerResolved: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { id: string }): void =>
      listener(payload.id)
    ipcRenderer.on('ncc:signer-resolved', handler)
    return () => {
      ipcRenderer.removeListener('ncc:signer-resolved', handler)
    }
  },
  onFocusAddress: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:focus-address', handler)
    return () => {
      ipcRenderer.removeListener('ncc:focus-address', handler)
    }
  },
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NavState): void => listener(state)
    ipcRenderer.on('ncc:state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:state', handler)
    }
  },
  onConfig: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, config: AppConfig): void =>
      listener(config)
    ipcRenderer.on('ncc:config', handler)
    return () => {
      ipcRenderer.removeListener('ncc:config', handler)
    }
  },
  onPasswordStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PasswordVaultStatus): void =>
      listener(status)
    ipcRenderer.on('ncc:password-status', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-status', handler)
    }
  },
  onPasswordContext: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, context: PasswordContext): void =>
      listener(context)
    ipcRenderer.on('ncc:password-context', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-context', handler)
    }
  },
  onPasswordSaveRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: PasswordSaveRequest): void =>
      listener(request)
    ipcRenderer.on('ncc:password-save-request', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-save-request', handler)
    }
  },
  onPasswordToast: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, toast: PasswordToast): void =>
      listener(toast)
    ipcRenderer.on('ncc:password-toast', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-toast', handler)
    }
  },
  onExtensions: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ExtensionsState): void =>
      listener(state)
    ipcRenderer.on('ncc:extensions-state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:extensions-state', handler)
    }
  },
  onDownload: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, notice: DownloadNotice): void =>
      listener(notice)
    ipcRenderer.on('ncc:download', handler)
    return () => {
      ipcRenderer.removeListener('ncc:download', handler)
    }
  }
}

contextBridge.exposeInMainWorld('ncc', api)
