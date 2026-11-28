/**
 * IPC boundaries for extensions. The chrome renderer can manage installs; content
 * and extension pages can only call the narrow bridge, and their identity is derived
 * from the sender frame rather than a caller-supplied value.
 */

import { dialog, ipcMain, shell as electronShell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { EXTENSION_SCHEME, type ExtensionManifest, type ExtensionSender } from '@shared/extensions'
import { isChromeSender } from '../ipc-guard'
import type { BrowserShell } from '../shell'
import type { ExtensionService } from './runtime'

export interface ExtensionIpcDeps {
  shell: BrowserShell
}

export function registerExtensionIpc(service: ExtensionService, deps: ExtensionIpcDeps): void {
  const fromChrome = (event: IpcMainInvokeEvent): boolean => isChromeSender(event)

  const handle = <T>(channel: string, action: (...args: unknown[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromChrome(event)) throw new Error('Extensions are only managed by the browser chrome')
      return action(...args)
    })
  }

  handle('ncc:extensions-state', () => service.state())
  handle('ncc:extensions-set-developer', (value) => {
    service.setDeveloperMode(value === true)
    return service.state()
  })
  handle('ncc:extensions-prepare', async (kind) => {
    if (kind === 'folder' && !service.state().developerMode) {
      return { ok: false, error: 'Enable developer mode to load an unpacked extension' }
    }
    const result =
      kind === 'folder'
        ? await dialog.showOpenDialog(deps.shell.window, {
            title: 'Load unpacked extension',
            properties: ['openDirectory']
          })
        : await dialog.showOpenDialog(deps.shell.window, {
            title: 'Install extension package',
            properties: ['openFile'],
            filters: [
              { name: 'Extension packages', extensions: ['zip', 'nccx'] },
              { name: 'All files', extensions: ['*'] }
            ]
          })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Install cancelled' }
    return kind === 'folder'
      ? service.prepareFolder(result.filePaths[0])
      : service.prepareZip(result.filePaths[0])
  })
  handle('ncc:extensions-prepare-release', (reference) =>
    service.prepareRelease(typeof reference === 'string' ? reference.slice(0, 1024) : '')
  )
  handle('ncc:extensions-prepare-bundled-companion', () => service.prepareBundledCompanion())
  handle('ncc:extensions-check-update', (id) =>
    service.checkUpdate(typeof id === 'string' ? id : '')
  )
  handle('ncc:extensions-confirm', (token, privateTabs) =>
    service.confirmInstall(typeof token === 'string' ? token : '', {
      privateTabs: privateTabs === true
    })
  )
  handle('ncc:extensions-cancel', (token) => {
    if (typeof token === 'string') service.cancelInstall(token)
  })
  handle('ncc:extensions-remove', (id) => {
    if (typeof id === 'string') service.remove(id)
    return service.state()
  })
  handle('ncc:extensions-set-enabled', (id, value) => {
    if (typeof id === 'string') service.setEnabled(id, value === true)
    return service.state()
  })
  handle('ncc:extensions-set-private', (id, value) => {
    if (typeof id === 'string') service.setPrivateTabs(id, value === true)
    return service.state()
  })
  handle('ncc:extensions-reload', (id) => {
    if (typeof id === 'string') service.reload(id)
    return service.state()
  })
  handle('ncc:extensions-open-options', (id) => {
    if (typeof id === 'string') service.openOptions(id)
  })
  handle('ncc:extensions-reveal', (id) => {
    if (typeof id !== 'string') return
    const info = service.info(id)
    if (info) electronShell.showItemInFolder(info.installPath)
  })
  handle('ncc:extensions-action', (id, anchor) => {
    if (typeof id !== 'string') return
    const value =
      anchor && typeof anchor === 'object'
        ? (anchor as { top?: unknown; left?: unknown })
        : {}
    return service.clickAction(id, {
      top: typeof value.top === 'number' ? value.top : 80,
      left: typeof value.left === 'number' ? value.left : 80
    })
  })

  ipcMain.on('ext:plan', (event: IpcMainEvent, suppliedUrl: unknown) => {
    event.returnValue = planFor(service, event, suppliedUrl)
  })

  ipcMain.on('ext:manifest', (event: IpcMainEvent, id: unknown) => {
    event.returnValue = manifestFor(service, event, id)
  })

  ipcMain.handle('ext:invoke', async (event, payload: unknown) => {
    const value =
      payload && typeof payload === 'object'
        ? (payload as { extensionId?: unknown; method?: unknown; args?: unknown })
        : {}
    if (typeof value.extensionId !== 'string' || typeof value.method !== 'string') {
      throw new Error('Invalid extension call')
    }
    const sender = senderOf(service, event, value.extensionId, value.method)
    const args = Array.isArray(value.args) ? value.args : []
    return service.invoke(value.extensionId, value.method, args, sender)
  })

  ipcMain.on('ext:event-result', (event: IpcMainEvent, payload: unknown) => {
    service.handleEventResult(event.sender.id, payload)
  })
  ipcMain.on('ext:run-result', (event: IpcMainEvent, payload: unknown) => {
    service.handleEventResult(event.sender.id, payload)
  })
}

function planFor(
  service: ExtensionService,
  event: IpcMainEvent,
  suppliedUrl: unknown
): unknown {
  try {
    if (event.senderFrame?.parent) return []
    const page = service.pageForContents(event.sender.id)
    if (!page) return []
    // At preload time the committed frame URL can still be about:blank. The
    // preload is trusted and sends its own location, so use it when the frame has
    // not caught up; never accept a non-web scheme.
    const frameUrl = event.senderFrame?.url ?? ''
    const url =
      /^(https?|ncc):\/\//i.test(frameUrl)
        ? frameUrl
        : typeof suppliedUrl === 'string' && /^(https?|ncc):\/\//i.test(suppliedUrl)
          ? suppliedUrl
          : ''
    if (!url) return []
    return service.planFor(event.sender.id, url)
  } catch {
    return []
  }
}

function manifestFor(
  service: ExtensionService,
  event: IpcMainEvent,
  id: unknown
): ExtensionManifest | null {
  try {
    if (typeof id !== 'string' || event.senderFrame?.parent) return null
    const url = new URL(event.senderFrame?.url ?? '')
    if (url.protocol !== `${EXTENSION_SCHEME}:` || url.hostname !== id) return null
    return service.manifest(id)
  } catch {
    return null
  }
}

function senderOf(
  service: ExtensionService,
  event: IpcMainInvokeEvent,
  extensionId: string,
  _method: string
): ExtensionSender {
  let url: URL
  try {
    url = new URL(event.senderFrame?.url ?? '')
  } catch {
    throw new Error('The requesting frame is gone')
  }

  if (url.protocol === `${EXTENSION_SCHEME}:`) {
    if (event.senderFrame?.parent) throw new Error('Extension pages must be top-level')
    if (url.hostname !== extensionId) throw new Error('The extension id does not match the page')
    const background = url.pathname === '/__ncc_background__.html'
    return {
      extensionId,
      from: background ? 'background' : 'page',
      tab: null,
      incognito: false,
      extensionPagePath: url.pathname
    }
  }

  if (event.senderFrame?.parent) throw new Error('Extensions only run in the top frame')
  const page = service.pageForContents(event.sender.id)
  if (!page) throw new Error('Extensions only run in browser tabs')
  if (!service.allowed(extensionId, url.toString(), page)) {
    throw new Error('This extension does not have access to this page')
  }
  return {
    extensionId,
    from: 'content',
    tab: page,
    incognito: page.kind !== 'normal'
  }
}
