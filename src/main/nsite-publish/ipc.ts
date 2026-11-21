import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type {
  NsiteFolderScan,
  NsiteProgress,
  NsitePublishInput,
  NsiteSiteFile
} from '@shared/nsite-publish'
import type { BrowserShell } from '../shell'
import type { NsitePublishService } from './service'

interface ScanToken {
  folder: string
  files: NsiteSiteFile[]
  at: number
}

const TOKEN_TTL_MS = 30 * 60_000

/**
 * Folder tokens: the renderer never gets a filesystem path. A token is created by the
 * native dialog, holds the scanned file list in main, and is consumed by the publish
 * call, so the chrome cannot ask the publisher to read an arbitrary directory.
 */
export function registerNsitePublishIpc(
  service: NsitePublishService,
  shell: BrowserShell
): void {
  const tokens = new Map<string, ScanToken>()

  const fromChrome = (sender: Electron.WebContents): boolean =>
    !shell.window.isDestroyed() && sender === shell.window.webContents

  const prune = (): void => {
    const cutoff = Date.now() - TOKEN_TTL_MS
    for (const [token, entry] of tokens) if (entry.at < cutoff) tokens.delete(token)
  }

  const progress = (event: Electron.IpcMainInvokeEvent, value: NsiteProgress): void => {
    if (fromChrome(event.sender)) shell.sendToChrome('ncc:nsite-progress', value)
  }

  ipcMain.handle('ncc:nsite-state', () => service.state())

  ipcMain.handle('ncc:nsite-pick-folder', async (event): Promise<NsiteFolderScan | null> => {
    if (!fromChrome(event.sender)) throw new Error('Sites are only available to the browser chrome')
    const testFolder = process.env.NCC_NSITE_FOLDER
    let folder: string | undefined
    if (testFolder) {
      folder = testFolder
    } else {
      const result = await dialog.showOpenDialog(shell.window, {
        title: 'Choose the built site folder',
        properties: ['openDirectory']
      })
      folder = result.filePaths[0]
      if (result.canceled || !folder) return null
    }
    const scan = await service.scanFolder(folder)
    prune()
    const token = randomBytes(16).toString('hex')
    tokens.set(token, { folder, files: scan.files, at: Date.now() })
    return {
      token,
      folderName: basename(folder),
      files: scan.files,
      totalBytes: scan.totalBytes,
      problems: scan.problems
    }
  })

  ipcMain.handle('ncc:nsite-publish', async (event, payload: Partial<NsitePublishInput>) => {
    if (!fromChrome(event.sender)) throw new Error('Sites are only available to the browser chrome')
    if (!payload || typeof payload.token !== 'string') throw new Error('Choose a site folder first')
    prune()
    const scan = tokens.get(payload.token)
    if (!scan) throw new Error('That folder scan expired. Choose the folder again.')
    return service.publish(
      {
        token: payload.token,
        folder: scan.folder,
        files: scan.files,
        siteId: typeof payload.siteId === 'string' ? payload.siteId : null,
        title: typeof payload.title === 'string' ? payload.title : '',
        description: typeof payload.description === 'string' ? payload.description : '',
        source: typeof payload.source === 'string' ? payload.source : '',
        servers: Array.isArray(payload.servers)
          ? payload.servers.filter((server): server is string => typeof server === 'string')
          : [],
        relays: Array.isArray(payload.relays)
          ? payload.relays.filter((relay): relay is string => typeof relay === 'string')
          : []
      },
      (value) => progress(event, value)
    )
  })

  ipcMain.handle('ncc:nsite-verify', async (event, id: unknown) => {
    if (!fromChrome(event.sender)) throw new Error('Sites are only available to the browser chrome')
    if (typeof id !== 'string') throw new Error('A site id is required')
    return service.verify(id, (value) => progress(event, value))
  })

  ipcMain.handle('ncc:nsite-remove', (event, id: unknown) => {
    if (!fromChrome(event.sender)) throw new Error('Sites are only available to the browser chrome')
    if (typeof id !== 'string') throw new Error('A site id is required')
    service.remove(id)
    return service.state()
  })
}
