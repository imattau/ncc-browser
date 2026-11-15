import { mkdirSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, type DownloadItem, type Session } from 'electron'
import { sortDownloads } from '@shared/downloads'
import type { DownloadNotice, DownloadState, TabKind } from '@shared/types'

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

export interface DownloadManagerOptions {
  directory?: string
  notify?: (notice: DownloadNotice) => void
  now?: () => number
}

interface Entry {
  notice: DownloadNotice
  item: DownloadItem | null
  lastEmit: number
  kind: TabKind
}

const PROGRESS_INTERVAL_MS = 250

/**
 * Tracks session downloads for the chrome UI: progress, cancellation and the final
 * path. Finished entries stay until the user clears them, so a saved file can be
 * revealed after the fact.
 */
export class DownloadManager {
  private readonly directory: string
  private readonly notify: (notice: DownloadNotice) => void
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly reserved = new Set<string>()
  private counter = 0

  constructor(options: DownloadManagerOptions = {}) {
    this.directory = options.directory ?? app.getPath('downloads')
    this.notify = options.notify ?? (() => undefined)
    this.now = options.now ?? (() => Date.now())
  }

  install(session: Session, kind: TabKind = 'normal'): void {
    session.on('will-download', (_event, item) => this.track(item, kind))
  }

  list(): DownloadNotice[] {
    return sortDownloads([...this.entries.values()].map((entry) => entry.notice))
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry?.item) return false
    entry.item.cancel()
    return true
  }

  /** Absolute path of a completed download, or null when it is not finished. */
  pathFor(id: string): string | null {
    const entry = this.entries.get(id)
    if (!entry || entry.notice.state !== 'completed' || !entry.notice.path) return null
    return entry.notice.path
  }

  clearFinished(): DownloadNotice[] {
    for (const [id, entry] of this.entries) {
      if (entry.notice.state !== 'started') this.entries.delete(id)
    }
    return this.list()
  }

  /** Drop the metadata of downloads started by a private or Tor session. */
  clearFor(kind: TabKind): DownloadNotice[] {
    for (const [id, entry] of this.entries) {
      if (entry.kind === kind) this.entries.delete(id)
    }
    return this.list()
  }

  private track(item: DownloadItem, kind: TabKind): void {
    const filename = safeFilename(item.getFilename() || 'download')
    // Reserve the name while the download runs so two files with the same name do
    // not both pick the same free path before either exists on disk.
    const target = uniquePath(
      this.directory,
      filename,
      (path) => this.reserved.has(path) || existsSync(path)
    )
    const id = `dl${++this.counter}`
    const startedAt = this.now()

    try {
      mkdirSync(this.directory, { recursive: true })
      item.setSavePath(target)
      this.reserved.add(target)
    } catch (error) {
      console.warn('[downloads] could not prepare destination:', error)
      item.cancel()
      const failed: DownloadNotice = {
        id,
        filename,
        state: 'failed',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt,
        private: kind !== 'normal'
      }
      this.entries.set(id, { notice: failed, item: null, lastEmit: startedAt, kind })
      this.notify(failed)
      return
    }

    const notice: DownloadNotice = {
      id,
      filename,
      state: 'started',
      path: target,
      receivedBytes: 0,
      totalBytes: Math.max(0, item.getTotalBytes()),
      startedAt,
      private: kind !== 'normal'
    }
    const entry: Entry = { notice, item, lastEmit: 0, kind }
    this.entries.set(id, entry)
    this.notify(notice)

    item.on('updated', (_event, state) => {
      if (state !== 'progressing') return
      const now = this.now()
      const received = Math.max(0, item.getReceivedBytes())
      const total = Math.max(0, item.getTotalBytes())
      const done = total > 0 && received >= total
      if (!done && now - entry.lastEmit < PROGRESS_INTERVAL_MS) return
      entry.lastEmit = now
      entry.notice = { ...entry.notice, receivedBytes: received, totalBytes: total }
      this.notify(entry.notice)
    })

    item.once('done', (_event, state) => {
      this.reserved.delete(target)
      const mapped: DownloadState =
        state === 'completed' || state === 'cancelled' ? state : 'failed'
      entry.item = null
      entry.notice = {
        ...entry.notice,
        state: mapped,
        receivedBytes: Math.max(0, item.getReceivedBytes()),
        totalBytes: Math.max(0, item.getTotalBytes())
      }
      this.notify(entry.notice)
    })
  }
}
