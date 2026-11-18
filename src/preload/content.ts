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

  contextBridge.exposeInMainWorld('webln', {
    enable: (): Promise<unknown> => ipcRenderer.invoke('nwc:page-info'),
    getInfo: (): Promise<unknown> => ipcRenderer.invoke('nwc:page-info'),
    getBalance: async (): Promise<{ balance: number }> => ({ balance: (await ipcRenderer.invoke('nwc:page-balance') as { balance: number }).balance / 1000 }),
    sendPayment: (paymentRequest: string | { paymentRequest: string }): Promise<unknown> =>
      ipcRenderer.invoke('nwc:page-pay', typeof paymentRequest === 'string' ? paymentRequest : paymentRequest.paymentRequest),
    makeInvoice: (args: { amount: number; defaultDescription?: string }): Promise<unknown> =>
      ipcRenderer.invoke('nwc:page-invoice', args)
  })

  // Lightning payment links are handed to NCC's in-app confirmation instead of an
  // external wallet app. The trusted main process derives the origin from this frame.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
    const hrefInvoice = anchor && /^lightning:/i.test(anchor.href) ? anchor.href.replace(/^lightning:/i, '') : null
    const textInvoice = target?.textContent?.slice(0, 5000).match(/\bln(?:bc|tb|bcrt)[0-9a-z]{20,}/i)?.[0] ?? null
    const invoice = hrefInvoice ?? textInvoice
    if (typeof invoice !== 'string' || !/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) return
    if (hrefInvoice) event.preventDefault()
    void ipcRenderer.invoke('nwc:page-pay', invoice).catch(() => undefined)
  }, true)
}
