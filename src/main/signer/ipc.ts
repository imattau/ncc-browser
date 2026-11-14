import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'
import { isNostrId } from '@shared/ncc-url'
import type { Caller, Nip07Service } from './service'

/**
 * NIP-07 IPC endpoints, callable only from a sandboxed content preload. The caller's
 * origin is derived from the main frame, never from a parameter supplied by the page.
 */
export function registerNip07(service: Nip07Service, contentSession: Session): void {
  ipcMain.handle('nip07:get-public-key', (event) =>
    service.getPublicKey(callerOf(event, contentSession))
  )

  ipcMain.handle('nip07:sign-event', (event, template: unknown) =>
    service.signEvent(callerOf(event, contentSession), template)
  )

  ipcMain.handle('nip07:nip04-encrypt', (event, peer: string, plaintext: unknown) =>
    service.nip04Encrypt(callerOf(event, contentSession), peer, plaintext)
  )

  ipcMain.handle('nip07:nip04-decrypt', (event, peer: string, ciphertext: unknown) =>
    service.nip04Decrypt(callerOf(event, contentSession), peer, ciphertext)
  )

  ipcMain.handle('nip07:nip44-encrypt', (event, peer: string, plaintext: unknown) =>
    service.nip44Encrypt(callerOf(event, contentSession), peer, plaintext)
  )

  ipcMain.handle('nip07:nip44-decrypt', (event, peer: string, ciphertext: unknown) =>
    service.nip44Decrypt(callerOf(event, contentSession), peer, ciphertext)
  )

  ipcMain.handle('nip07:get-relays', () => service.getRelays())
}

function callerOf(event: IpcMainInvokeEvent, contentSession: Session): Caller {
  if (event.sender.session !== contentSession) {
    throw new Error('NIP-07 is only available to page content')
  }

  let frame
  try {
    frame = event.senderFrame
  } catch {
    throw new Error('The requesting frame is gone')
  }
  if (!frame) throw new Error('The requesting frame is gone')
  if (frame.parent) throw new Error('NIP-07 is only available to the top-level frame')

  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    throw new Error('NIP-07 is not available on this page')
  }

  if (url.protocol === 'ncc:') {
    const pubkey = url.hostname.toLowerCase()
    if (!isNostrId(pubkey)) throw new Error('Not an NCC page')

    const raw = url.pathname.replace(/^\/+/, '')
    const service = raw.startsWith('_/') ? raw.slice(2).split('/')[0] : raw.split('/')[0]
    const label = `ncc://${pubkey}/${service || 'addr'}`
    return { origin: label, label }
  }

  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return { origin: url.origin, label: url.origin }
  }

  throw new Error('NIP-07 is not available on this page')
}
