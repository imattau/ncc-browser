import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { requireChrome } from '../ipc-guard'
import type { BrowserShell } from '../shell'
import type { WalletService } from './service'

export function registerWalletIpc(service: WalletService, shell: BrowserShell): void {
  const handle = (channel: string, action: (...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      requireChrome(event, 'Wallet')
      return action(...args)
    })
  }
  handle('ncc:wallet-status', () => service.status())
  handle('ncc:wallet-snapshot', () => service.snapshot())
  handle('ncc:wallet-settings', () => service.settings())
  handle('ncc:wallet-set-settings', (input) => service.setSettings(input && typeof input === 'object' ? input as { esploraUrl?: string } : {}))
  handle('ncc:wallet-btc-prepare', (address, amount) => {
    if (typeof address !== 'string' || typeof amount !== 'string') throw new Error('Enter a Bitcoin address and amount')
    return service.prepareBitcoinSend(address, amount)
  })
  handle('ncc:wallet-btc-confirm', (token) => {
    if (typeof token !== 'string') throw new Error('Missing send confirmation')
    return service.confirmBitcoinSend(token)
  })
  handle('ncc:wallet-xmr-load', () => service.loadMoneroRecord())
  handle('ncc:wallet-xmr-save', (record) => service.saveMoneroRecord(record as never))
  handle('ncc:wallet-xmr-cache-load', () => service.loadMoneroCache())
  handle('ncc:wallet-xmr-cache-save', (data) => service.saveMoneroCache(data as never))
  handle('ncc:wallet-xmr-delete', () => service.deleteMoneroRecord())
}
