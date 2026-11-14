import { contextBridge, ipcRenderer } from 'electron'
import type { NccApi } from '@shared/api'
import type { DownloadNotice, NavState } from '@shared/types'

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
