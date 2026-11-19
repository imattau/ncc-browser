import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { BrowserShell } from '../shell'
import type { PaymentCardService } from './service'

export function registerPaymentCardIpc(service: PaymentCardService, shell: BrowserShell): void {
  const fromChrome = (event: IpcMainInvokeEvent): boolean => event.sender === shell.window.webContents
  const handle = (channel: string, action: (...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromChrome(event)) throw new Error('Payment cards are only available to browser chrome')
      return action(...args)
    })
  }
  handle('ncc:payment-cards-status', () => service.status())
  handle('ncc:payment-cards-unlock', () => service.unlock())
  handle('ncc:payment-cards-list', () => service.list())
  handle('ncc:payment-cards-save', (draft) => draft && typeof draft === 'object' ? service.save(draft as never) : { ok: false, error: 'Invalid card' })
  handle('ncc:payment-cards-remove', (id) => typeof id === 'string' ? service.remove(id) : { ok: false, error: 'Invalid card' })
  handle('ncc:payment-cards-sync', () => service.syncNow())
  handle('ncc:payment-cards-respond', (id, action) => typeof id === 'string' && (action === 'save' || action === 'dismiss') ? service.respond(id, action) : { ok: false, error: 'Invalid request' })

  ipcMain.on('payments:field-focused', (event) => {
    if (fromContent(event, shell)) service.handleFieldFocused(event.sender.id)
  })
  ipcMain.on('payments:capture', (event, payload) => {
    if (fromContent(event, shell)) service.handleCapture(event.sender.id, payload)
  })
  ipcMain.on('payments:fill-selected', (event, id) => {
    if (!fromContent(event, shell) || typeof id !== 'string') return
    void service.fill(event.sender.id, id).then((result) => {
      if (!result.ok) shell.sendToContent(shell.tabIdForContents(event.sender.id) ?? '', 'payments:fill-error', result.error ?? 'Could not fill card')
    })
  })
  ipcMain.on('payments:fill-result', (event, result) => {
    if (!fromContent(event, shell)) return
    if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
      shell.sendToChrome('ncc:password-toast', { tone: 'error', message: 'The card could not be filled into this form.' })
    }
  })
}

function fromContent(event: IpcMainEvent, shell: BrowserShell): boolean {
  if (shell.tabIdForContents(event.sender.id) == null) return false
  try { return event.senderFrame?.parent == null } catch { return false }
}
