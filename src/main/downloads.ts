import { mkdirSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, type Session } from 'electron'
import type { DownloadNotice } from '@shared/types'

/**
 * Strip anything that could escape the download directory or upset the filesystem.
 * Remote content controls the suggested filename, so this is a trust boundary.
 */
export function safeFilename(input: string): string {
  const withoutPath = basename(String(input).replace(/\\/g, '/'))
  const cleaned = withoutPath
    .replace(/[\u0000-\u001f<>:"|?*/]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const name = cleaned || 'download'
  return name.length > 180 ? name.slice(-180) : name
}

/** Pick a non-colliding path, keeping the extension: `file.txt` → `file (1).txt`. */
export function uniquePath(
  directory: string,
  filename: string,
  exists: (path: string) => boolean = existsSync
): string {
  const direct = join(directory, filename)
  if (!exists(direct)) return direct

  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`)
    if (!exists(candidate)) return candidate
  }
  return join(directory, `${stem}-${Date.now()}${extension}`)
}

export interface DownloadHandlerOptions {
  directory?: string
  notify: (notice: DownloadNotice) => void
}

export function installDownloadHandler(
  session: Session,
  options: DownloadHandlerOptions
): void {
  const directory = options.directory ?? app.getPath('downloads')
  let counter = 0

  session.on('will-download', (_event, item) => {
    const filename = safeFilename(item.getFilename() || 'download')
    const target = uniquePath(directory, filename)
    const id = `dl${++counter}`

    try {
      mkdirSync(directory, { recursive: true })
      item.setSavePath(target)
    } catch (error) {
      console.warn('[downloads] could not prepare destination:', error)
      item.cancel()
      options.notify({ id, filename, state: 'failed' })
      return
    }

    options.notify({ id, filename, state: 'started', path: target })
    item.once('done', (_doneEvent, state) => {
      const mapped = state === 'completed' || state === 'cancelled' ? state : 'failed'
      options.notify({ id, filename, state: mapped, path: target })
    })
  })
}
