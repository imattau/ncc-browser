import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BrowserShell } from '../shell'
import type { NwcService } from './nwc-service'
import type { ContentSessions } from '../sessions'
import { signerOriginFromUrl } from '../signer/origin'
import { decodeBolt11Invoice } from '@shared/nwc'

export function registerNwcIpc(service: NwcService, shell: BrowserShell, sessions: ContentSessions): void {
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (event.sender !== shell.window.webContents) throw new Error('NWC settings are only available to browser chrome')
    return action(...args)
  })
  handle('ncc:nwc-status', () => service.status())
  handle('ncc:nwc-connect', (uri) => {
    if (typeof uri !== 'string' || uri.length > 4096) throw new Error('Enter a valid NWC connection URI')
    return service.connect(uri)
  })
  handle('ncc:nwc-disconnect', () => { service.disconnect(); return service.status() })
  handle('ncc:nwc-refresh', () => service.refresh())
  handle('ncc:nwc-pay', (invoice) => {
    if (typeof invoice !== 'string' || invoice.length > 4096) throw new Error('Invalid Lightning invoice')
    return service.payInvoice(invoice)
  })
  handle('ncc:nwc-make-invoice', (params) => {
    if (!params || typeof params !== 'object') throw new Error('Enter an invoice amount')
    const value = params as { amount?: unknown; description?: unknown; expiry?: unknown }
    if (typeof value.amount !== 'number' || !Number.isSafeInteger(value.amount) || value.amount <= 0) throw new Error('Invoice amount must be a positive number of millisatoshis')
    return service.makeInvoice({ amount: value.amount, ...(typeof value.description === 'string' ? { description: value.description.slice(0, 256) } : {}), ...(typeof value.expiry === 'number' ? { expiry: value.expiry } : {}) })
  })
  handle('ncc:nwc-lookup-invoice', (params) => {
    if (!params || typeof params !== 'object') throw new Error('Enter an invoice or payment hash')
    const value = params as { invoice?: unknown; payment_hash?: unknown }
    const invoice = typeof value.invoice === 'string' ? value.invoice.trim() : undefined
    const payment_hash = typeof value.payment_hash === 'string' ? value.payment_hash.trim() : undefined
    if ((!invoice && !payment_hash) || invoice && invoice.length > 4096 || payment_hash && !/^[0-9a-f]{64}$/i.test(payment_hash)) throw new Error('Enter a valid invoice or payment hash')
    return service.lookupInvoice({ ...(invoice ? { invoice } : {}), ...(payment_hash ? { payment_hash } : {}) })
  })

  const pageCaller = (event: IpcMainInvokeEvent): string => {
    const frame = event.senderFrame
    if (!frame || frame.parent || ![sessions.normal, sessions.private, sessions.tor].includes(event.sender.session)) throw new Error('WebLN is only available to top-level browser pages')
    const page = signerOriginFromUrl(frame.url)
    if (!page) throw new Error('WebLN is unavailable on this page')
    return page.label
  }
  ipcMain.handle('nwc:page-info', async (event) => { pageCaller(event); return service.getInfo() })
  ipcMain.handle('nwc:page-balance', async (event) => { pageCaller(event); return service.getBalance() })
  ipcMain.handle('nwc:page-invoice', async (event, args: unknown) => {
    pageCaller(event)
    if (!args || typeof args !== 'object') throw new Error('Invoice details are missing')
    const value = args as { amount?: unknown; defaultMemo?: unknown }
    if (typeof value.amount !== 'number' || !Number.isSafeInteger(value.amount) || value.amount <= 0 || value.amount > Number.MAX_SAFE_INTEGER / 1000) throw new Error('Invoice amount must be positive sats')
    return service.makeInvoice({ amount: value.amount * 1000, ...(typeof value.defaultMemo === 'string' ? { description: value.defaultMemo.slice(0, 256) } : {}) })
  })
  ipcMain.handle('nwc:page-pay', async (event, args: unknown) => {
    const origin = pageCaller(event)
    const invoice = typeof args === 'string' ? args : (args as { paymentRequest?: unknown } | null)?.paymentRequest
    if (typeof invoice !== 'string' || invoice.length > 4096) throw new Error('Invalid Lightning invoice')
    const decoded = decodeBolt11Invoice(invoice)
    const amount = decoded.amountMsat ? `${(Number(decoded.amountMsat) / 1000).toLocaleString()} sats` : 'amount not encoded'
    const answer = await dialog.showMessageBox(shell.window, {
      type: 'warning', buttons: ['Cancel', 'Pay'], defaultId: 0, cancelId: 0,
      title: 'Confirm Lightning payment', message: `${origin} requests a Lightning payment`, detail: `Invoice amount: ${amount}\nInvoice: ${decoded.invoice.slice(0, 120)}${decoded.invoice.length > 120 ? '…' : ''}\n\nOnly continue if you trust this page and have checked the payment.`
    })
    if (answer.response !== 1) throw new Error('Payment cancelled')
    return service.payInvoice(decoded.invoice)
  })
}
