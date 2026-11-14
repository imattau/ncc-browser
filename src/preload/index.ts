import { contextBridge, ipcRenderer } from 'electron'
import type { NccApi } from '@shared/api'
import type { NavState } from '@shared/types'

const api: NccApi = {
  navigate: (input) => ipcRenderer.invoke('ncc:navigate', input),
  back: () => ipcRenderer.invoke('ncc:back'),
  forward: () => ipcRenderer.invoke('ncc:forward'),
  reload: () => ipcRenderer.invoke('ncc:reload'),
  stop: () => ipcRenderer.invoke('ncc:stop'),
  getState: () => ipcRenderer.invoke('ncc:get-state'),
  getConfig: () => ipcRenderer.invoke('ncc:get-config'),
  setRelays: (relays) => ipcRenderer.invoke('ncc:set-relays', relays),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NavState): void => listener(state)
    ipcRenderer.on('ncc:state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:state', handler)
    }
  }
}

contextBridge.exposeInMainWorld('ncc', api)
