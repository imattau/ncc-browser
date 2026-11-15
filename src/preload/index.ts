import { contextBridge, ipcRenderer } from 'electron'
import type { NccApi } from '@shared/api'
import type { Bookmark, DownloadNotice, NavState, SignerRequest } from '@shared/types'

const api: NccApi = {
  navigate: (input) => ipcRenderer.invoke('ncc:navigate', input),
  back: () => ipcRenderer.invoke('ncc:back'),
  forward: () => ipcRenderer.invoke('ncc:forward'),
  reload: () => ipcRenderer.invoke('ncc:reload'),
  forceReload: () => ipcRenderer.invoke('ncc:force-reload'),
  stop: () => ipcRenderer.invoke('ncc:stop'),
  toggleTor: () => ipcRenderer.invoke('ncc:toggle-tor'),
  newTab: (input) => ipcRenderer.invoke('ncc:new-tab', input),
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
  setGossip: (value) => ipcRenderer.invoke('ncc:set-gossip', value),
  setAnchorRequired: (value) => ipcRenderer.invoke('ncc:set-anchor-required', value),
  setPreferTor: (value) => ipcRenderer.invoke('ncc:set-prefer-tor', value),
  setTorMode: (mode) => ipcRenderer.invoke('ncc:set-tor-mode', mode),
  setTorSocks: (socks) => ipcRenderer.invoke('ncc:set-tor-socks', socks),
  setTorConfig: (config) => ipcRenderer.invoke('ncc:set-tor-config', config),
  torStatus: () => ipcRenderer.invoke('ncc:tor-status'),
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
