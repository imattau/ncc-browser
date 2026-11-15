import { clipboard, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserShell } from '../shell'
import type { PasswordClipboard, PasswordFileDialogs, PasswordService } from './service'

export interface PasswordIpcDeps {
  shell: BrowserShell
}

/** Register chrome-only and content-only IPC. Nothing here is reachable from pages. */
export function registerPasswordIpc(service: PasswordService, deps: PasswordIpcDeps): void {
  const fromChrome = (event: IpcMainInvokeEvent): boolean =>
    event.sender === deps.shell.window.webContents

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
  handle('ncc:password-unlock', () => service.unlock())
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
  handle('ncc:password-config', (input) =>
    input && typeof input === 'object' ? service.setConfig(input) : service.status()
  )
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
