import { contextBridge, ipcRenderer } from 'electron'
import { installPasswordManager } from './password-manager'

/**
 * Content preload for remote pages. The only thing exposed is a NIP-07 provider;
 * there is no general IPC bridge, no Node, and no access to the chrome UI. The
 * password bridge runs entirely in this isolated world and exposes nothing.
 */

const isMainFrame = (process as unknown as { isMainFrame?: boolean }).isMainFrame !== false

if (isMainFrame) {
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
