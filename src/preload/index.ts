import { contextBridge, ipcRenderer } from 'electron'
import type { NccApi } from '@shared/api'
import type { DownloadNotice, NavState, SignerRequest } from '@shared/types'

const api: NccApi = {
  navigate: (input) => ipcRenderer.invoke('ncc:navigate', input),
  back: () => ipcRenderer.invoke('ncc:back'),
  forward: () => ipcRenderer.invoke('ncc:forward'),
  reload: () => ipcRenderer.invoke('ncc:reload'),
  stop: () => ipcRenderer.invoke('ncc:stop'),
  newTab: (input) => ipcRenderer.invoke('ncc:new-tab', input),
  closeTab: (id) => ipcRenderer.invoke('ncc:close-tab', id),
  selectTab: (id) => ipcRenderer.invoke('ncc:select-tab', id),
  getState: () => ipcRenderer.invoke('ncc:get-state'),
  getConfig: () => ipcRenderer.invoke('ncc:get-config'),
  setRelays: (relays) => ipcRenderer.invoke('ncc:set-relays', relays),
  setGossip: (value) => ipcRenderer.invoke('ncc:set-gossip', value),
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
