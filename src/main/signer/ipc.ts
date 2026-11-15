import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'
import type { TabKind } from '@shared/types'
import { signerOriginFromUrl } from './origin'
import type { Caller, Nip07Service } from './service'

/**
 * NIP-07 IPC endpoints, callable only from a sandboxed content preload. The caller's
 * origin is derived from the main frame, never from a parameter supplied by the page.
 */
export interface Nip07ContentSession {
  session: Session
  kind: TabKind
}

export function registerNip07(service: Nip07Service, sessions: Nip07ContentSession[]): void {
  ipcMain.handle('nip07:get-public-key', (event) =>
    service.getPublicKey(callerOf(event, sessions))
  )

  ipcMain.handle('nip07:sign-event', (event, template: unknown) =>
    service.signEvent(callerOf(event, sessions), template)
  )

  ipcMain.handle('nip07:nip04-encrypt', (event, peer: string, plaintext: unknown) =>
    service.nip04Encrypt(callerOf(event, sessions), peer, plaintext)
  )

  ipcMain.handle('nip07:nip04-decrypt', (event, peer: string, ciphertext: unknown) =>
    service.nip04Decrypt(callerOf(event, sessions), peer, ciphertext)
  )

  ipcMain.handle('nip07:nip44-encrypt', (event, peer: string, plaintext: unknown) =>
    service.nip44Encrypt(callerOf(event, sessions), peer, plaintext)
  )

  ipcMain.handle('nip07:nip44-decrypt', (event, peer: string, ciphertext: unknown) =>
    service.nip44Decrypt(callerOf(event, sessions), peer, ciphertext)
  )

  ipcMain.handle('nip07:get-relays', () => service.getRelays())
}

function callerOf(event: IpcMainInvokeEvent, sessions: Nip07ContentSession[]): Caller {
  const content = sessions.find((entry) => entry.session === event.sender.session)
  if (!content) {
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

  const resolved = signerOriginFromUrl(url.toString())
  if (!resolved) {
    throw new Error(
      url.protocol === 'ncc:' ? 'Not an NCC page' : 'NIP-07 is not available on this page'
    )
  }

  return {
    origin: resolved.origin,
    label: resolved.label,
    kind: content.kind,
    ephemeral: content.kind !== 'normal',
    torTab: content.kind === 'tor'
  }
}
