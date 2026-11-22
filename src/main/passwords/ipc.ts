import { clipboard, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { browserShellFor, browserShellForTabContents, type BrowserShell } from '../shell'
import { isChromeSender } from '../ipc-guard'
import type { PasswordClipboard, PasswordFileDialogs, PasswordService } from './service'
import type { PasskeyConfirmationRequest, PasswordConfig } from '@shared/passwords'

export interface PasswordIpcDeps {
  shell: BrowserShell
  afterUnlock?: () => Promise<void>
  afterConfigChange?: (input: Record<string, unknown>) => Promise<void>
}

/** Register chrome-only and content-only IPC. Nothing here is reachable from pages. */
export function registerPasswordIpc(service: PasswordService, deps: PasswordIpcDeps): void {
  const pendingPasskeyConfirmations = new Map<string, {
    shell: BrowserShell
    resolve: (choice: number | null) => void
    timer: NodeJS.Timeout
    onDestroyed: () => void
    choiceCount: number
    signal?: AbortSignal
    onAbort?: () => void
  }>()
  const pendingWebauthnRequests = new Map<string, { controller: AbortController; senderId: number }>()

  const fromChrome = (event: IpcMainInvokeEvent): boolean => isChromeSender(event)

  const pageRequest = (event: IpcMainEvent | IpcMainInvokeEvent): { tabId: string; origin: string; shell: BrowserShell; page: ReturnType<BrowserShell['pageForTab']> } | null => {
    const shell = browserShellForTabContents(event.sender)
    if (!shell || shell.tabIdForContents(event.sender.id) == null) return null
    try {
      if (event.senderFrame?.parent != null) return null
      const url = new URL(event.senderFrame?.url ?? '')
      if (url.protocol !== 'https:') return null
      const tabId = shell.tabIdForContents(event.sender.id)
      return tabId ? { tabId, origin: url.origin, shell, page: shell.pageForTab(tabId) } : null
    } catch { return null }
  }

  const settlePasskeyConfirmation = (id: string, choice: number | null): void => {
    const pending = pendingPasskeyConfirmations.get(id)
    if (!pending) return
    pendingPasskeyConfirmations.delete(id)
    clearTimeout(pending.timer)
    pending.shell.window.webContents.removeListener('destroyed', pending.onDestroyed)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
    pending.resolve(choice)
    if (!pending.shell.window.webContents.isDestroyed()) {
      pending.shell.window.webContents.send('ncc:passkey-confirmation-resolved', id)
    }
  }

  const approvePasskey = (shell: BrowserShell, site: string, accounts: string[], action: string, signal?: AbortSignal): Promise<number | null> => new Promise((resolve) => {
    if (shell.window.isDestroyed() || shell.window.webContents.isDestroyed()) {
      resolve(null)
      return
    }
    if (signal?.aborted) { resolve(null); return }
    const id = randomUUID()
    const onDestroyed = (): void => settlePasskeyConfirmation(id, null)
    const onAbort = (): void => settlePasskeyConfirmation(id, null)
    const timer = setTimeout(() => settlePasskeyConfirmation(id, null), 60_000)
    pendingPasskeyConfirmations.set(id, {
      shell,
      resolve,
      timer,
      onDestroyed,
      choiceCount: Math.max(accounts.length, 1), signal, onAbort
    })
    shell.window.webContents.once('destroyed', onDestroyed)
    signal?.addEventListener('abort', onAbort, { once: true })
    const request: PasskeyConfirmationRequest = {
      id,
      site,
      accounts,
      action: action === 'Create passkey' ? 'Create passkey' : 'Use passkey'
    }
    shell.window.webContents.send('ncc:passkey-confirmation', request)
  })

  ipcMain.handle('ncc:passkey-confirmation-response', (event, input: unknown) => {
    const shell = browserShellFor(event.sender)
    if (!shell || !input || typeof input !== 'object') return false
    const value = input as { id?: unknown; choice?: unknown }
    if (typeof value.id !== 'string') return false
    const pending = pendingPasskeyConfirmations.get(value.id)
    if (!pending || pending.shell !== shell) return false
    if (value.choice !== null && (!Number.isSafeInteger(value.choice) || (value.choice as number) < 0 || (value.choice as number) >= pending.choiceCount)) return false
    settlePasskeyConfirmation(value.id, value.choice as number | null)
    return true
  })

  const handle = <T>(
    channel: string,
    action: (...args: unknown[]) => T | Promise<T>
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromChrome(event)) throw new Error('Passwords are only available to the browser chrome')
      return action(...args)
    })
  }

  handle('ncc:password-status', () => service.status())
  handle('ncc:password-context', () => service.context())
  handle('ncc:password-unlock', async () => {
    const status = await service.unlock()
    await deps.afterUnlock?.().catch((error) => console.warn('[payment-cards] unlock failed:', error))
    return status
  })
  handle('ncc:password-lock', () => service.lock())
  handle('ncc:password-list', () => service.list())
  handle('ncc:password-entry', (id) => (typeof id === 'string' ? service.entry(id) : null))
  handle('ncc:password-reveal', (id) =>
    typeof id === 'string' ? service.reveal(id) : ''
  )
  handle('ncc:password-totp', (id) =>
    typeof id === 'string' ? service.totp(id) : { code: '', remaining: 0, period: 30 }
  )
  handle('ncc:password-copy', async (id, field) => {
    if (typeof id !== 'string') return { ok: false, error: 'Missing login' }
    if (field !== 'username' && field !== 'password' && field !== 'totp') {
      return { ok: false, error: 'Unknown field' }
    }
    try {
      return service.copy(id, field)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  })
  handle('ncc:password-generate', (options) =>
    service.generate(options && typeof options === 'object' ? options : {})
  )
  handle('ncc:password-save', (input) =>
    input && typeof input === 'object' ? service.saveEntry(input as never) : { ok: false, error: 'Invalid login' }
  )
  handle('ncc:password-remove', (id) =>
    typeof id === 'string' ? service.removeEntry(id) : { ok: false, error: 'Invalid login' }
  )
  handle('ncc:password-sync', () => service.syncNow())
  handle('ncc:password-fill', (id) =>
    typeof id === 'string' ? service.fill(id) : { ok: false, error: 'Invalid login' }
  )
  handle('ncc:password-config', async (input) => {
    if (!input || typeof input !== 'object') return service.status()
    const result = await service.setConfig(input as Partial<PasswordConfig>)
    await deps.afterConfigChange?.(input as Record<string, unknown>)
    return result
  })
  handle('ncc:password-remove-never', (origin) => {
    if (typeof origin === 'string') service.removeNeverSave(origin)
    return service.status()
  })
  handle('ncc:password-respond', (id, action) => {
    if (typeof id !== 'string') return { ok: false, error: 'Invalid request' }
    if (action !== 'save' && action !== 'never' && action !== 'dismiss') {
      return { ok: false, error: 'Invalid decision' }
    }
    return service.respondToSave(id, action)
  })
  handle('ncc:password-import-open', () => service.importOpen())
  handle('ncc:password-import-commit', (id, mode) => {
    if (typeof id !== 'string') return { ok: false, error: 'Invalid import' }
    return service.importCommit(id, mode === 'skip' || mode === 'add' ? mode : 'merge')
  })
  handle('ncc:password-export', (format) =>
    service.export(format === 'encrypted' ? 'encrypted' : 'csv')
  )

  ipcMain.handle('ncc:webauthn-create', async (event, input: unknown) => {
    const request = pageRequest(event)
    if (!request || !input || typeof input !== 'object') return { handled: false }
    return service.webauthnCreate(request.page, request.origin, input as never, (site, accounts, action) => approvePasskey(request.shell, site, accounts, action))
  })
  ipcMain.handle('ncc:webauthn-candidates', (event, input: unknown) => {
    const request = pageRequest(event)
    if (!request || !input || typeof input !== 'object') return false
    return service.hasWebauthnCandidates(request.page, request.origin, input as never)
  })
  ipcMain.handle('ncc:webauthn-get', async (event, input: unknown) => {
    const request = pageRequest(event)
    if (!request || !input || typeof input !== 'object') return { handled: false }
    const value = input as { options?: unknown; selectedCredentialId?: unknown; requestId?: unknown }
    const options = value.options && typeof value.options === 'object' ? value.options : input
    const requestId = typeof value.requestId === 'string' ? value.requestId : randomUUID()
    const controller = new AbortController()
    pendingWebauthnRequests.set(requestId, { controller, senderId: event.sender.id })
    const onNavigate = (_navigationEvent: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame) controller.abort()
    }
    event.sender.on('did-start-navigation', onNavigate)
    try {
      return await service.webauthnGet(request.page, request.origin, options as never,
        (site, accounts, action) => approvePasskey(request.shell, site, accounts, action, controller.signal),
        typeof value.selectedCredentialId === 'string' ? value.selectedCredentialId : undefined)
    } finally {
      event.sender.removeListener('did-start-navigation', onNavigate)
      pendingWebauthnRequests.delete(requestId)
    }
  })
  ipcMain.on('ncc:webauthn-cancel', (event, requestId: unknown) => {
    const pending = typeof requestId === 'string' ? pendingWebauthnRequests.get(requestId) : undefined
    const shell = browserShellForTabContents(event.sender)
    if (shell && shell.tabIdForContents(event.sender.id) != null && pending?.senderId === event.sender.id) pending.controller.abort()
  })

  ipcMain.on('ncc:webauthn-can-handle', (event, operation: unknown, input: unknown) => {
    const request = pageRequest(event)
    if (!request || (operation !== 'create' && operation !== 'get') || !input || typeof input !== 'object') {
      event.returnValue = false
      return
    }
    event.returnValue = service.canHandleWebauthn(request.page, request.origin, operation, input as never)
  })

  ipcMain.on('ncc:webauthn-available', (event) => {
    const request = pageRequest(event)
    event.returnValue = !!request && service.hasWebauthnCredentialsForPage(request.page, request.origin)
  })

  ipcMain.on('ncc:webauthn-authenticator-available', (event) => {
    const request = pageRequest(event)
    event.returnValue = !!request && service.isWebauthnAuthenticatorAvailable()
  })

  ipcMain.on('passwords:form-state', (event, payload) => {
    if (!fromContent(event, deps.shell)) return
    service.handleFormState(event.sender.id, payload)
  })

  ipcMain.on('passwords:capture', (event, payload) => {
    if (!fromContent(event, deps.shell)) return
    service.handleCapture(event.sender.id, payload)
  })

  ipcMain.on('passwords:fill-result', (event, payload) => {
    if (!fromContent(event, deps.shell)) return
    service.handleFillResult(payload)
  })
}

function fromContent(event: IpcMainEvent, shell: BrowserShell): boolean {
  if (shell.tabIdForContents(event.sender.id) == null) return false
  try {
    return event.senderFrame?.parent == null
  } catch {
    return false
  }
}

export function electronClipboard(): PasswordClipboard {
  return {
    writeText: (value) => clipboard.writeText(value),
    readText: () => clipboard.readText(),
    clear: () => clipboard.clear()
  }
}

export function electronFileDialogs(shell: BrowserShell): PasswordFileDialogs {
  return {
    async open(): Promise<{ path: string; text: string } | null> {
      const override = process.env.NCC_PASSWORDS_IMPORT?.trim()
      if (override) {
        if (!existsSync(override)) throw new Error(`Import file not found: ${override}`)
        return { path: override, text: readFileSync(override, 'utf8') }
      }
      const result = await dialog.showOpenDialog(shell.window, {
        title: 'Import passwords',
        properties: ['openFile'],
        filters: [
          { name: 'Password files', extensions: ['csv', 'json'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      const path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return null
      return { path, text: readFileSync(path, 'utf8') }
    },

    async save(defaultName: string, data: string): Promise<string | null> {
      const override = process.env.NCC_PASSWORDS_EXPORT?.trim()
      let path: string | undefined
      if (override) {
        path =
          existsSync(override) && statSync(override).isDirectory()
            ? join(override, defaultName)
            : override
      } else {
        const result = await dialog.showSaveDialog(shell.window, {
          title: 'Export passwords',
          defaultPath: defaultName,
          filters: defaultName.endsWith('.csv')
            ? [{ name: 'CSV', extensions: ['csv'] }]
            : [{ name: 'Encrypted vault', extensions: ['json'] }]
        })
        path = result.canceled ? undefined : result.filePath
      }
      if (!path) return null
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data, { encoding: 'utf8', mode: 0o600 })
      chmodSync(path, 0o600)
      return path
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
