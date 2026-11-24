/**
 * Hand-offs to external apps that understand a Nostr identity. ncc-browser builds the
 * link; the target app owns its own signer and session, so nothing here shares key
 * material or state.
 */

import { ipcMain, shell } from 'electron'
import { whiteNoiseUserUrl } from '@shared/white-noise'
import { isChromeSender } from './ipc-guard'

export function registerExternalAppsIpc(): void {
  ipcMain.handle('ncc:open-in-white-noise', (event, npub: unknown) => {
    if (!isChromeSender(event)) throw new Error('Only available to the browser chrome')
    if (typeof npub !== 'string') throw new Error('Expected an npub')
    void shell.openExternal(whiteNoiseUserUrl(npub))
  })
}
