import { contextBridge, ipcRenderer } from 'electron'
import { installPasswordManager } from './password-manager'
import { installExtensionRuntime } from './extension-content'
import { installExtensionPage } from './extension-page'

/**
 * Content preload for remote pages and extension pages. Web/NCC pages get a NIP-07
 * provider plus the isolated password and extension runtimes; `ncc-ext://` pages get
 * only the extension shim. There is no general IPC bridge and no Node either way.
 */

const isMainFrame = (process as unknown as { isMainFrame?: boolean }).isMainFrame !== false

if (location.protocol === 'ncc-ext:') {
  if (isMainFrame) installExtensionPage()
} else if (isMainFrame) {
  installExtensionRuntime()
  installPasswordManager()

  const nip04 = {
    encrypt: (peer: string, plaintext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip04-encrypt', peer, plaintext),
    decrypt: (peer: string, ciphertext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip04-decrypt', peer, ciphertext)
  }

  const nip44 = {
    encrypt: (peer: string, plaintext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip44-encrypt', peer, plaintext),
    decrypt: (peer: string, ciphertext: string): Promise<string> =>
      ipcRenderer.invoke('nip07:nip44-decrypt', peer, ciphertext)
  }

  contextBridge.exposeInMainWorld('nostr', {
    getPublicKey: (): Promise<string> => ipcRenderer.invoke('nip07:get-public-key'),
    signEvent: (event: unknown): Promise<unknown> =>
      ipcRenderer.invoke('nip07:sign-event', event),
    getRelays: (): Promise<Record<string, { read: boolean; write: boolean }>> =>
      ipcRenderer.invoke('nip07:get-relays'),
    nip04,
    nip44
  })
}
