import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ipcMain } from 'electron'
import {
  MAX_PUBLISH_DRAFT_BYTES,
  PUBLISH_DRAFT_KINDS,
  type PublishDraftKind
} from '@shared/publish-drafts'
import { requireChrome } from './ipc-guard'

type Drafts = Partial<Record<PublishDraftKind, unknown>>

function isKind(value: unknown): value is PublishDraftKind {
  return PUBLISH_DRAFT_KINDS.includes(value as PublishDraftKind)
}

/**
 * `userData/publish-drafts.json`: one unfinished form of each kind. Local only, never
 * published or synced. Writes are atomic and `0600`, and happen straight away so that
 * a crash keeps what was typed. The renderer checks the shape of what it reads back.
 */
export class PublishDraftStore {
  constructor(private readonly filePath: string) {}

  load(kind: PublishDraftKind): unknown {
    return this.read()[kind] ?? null
  }

  save(kind: PublishDraftKind, value: unknown): void {
    const drafts = this.read()
    if (value === null || value === undefined) {
      if (!(kind in drafts)) return
      delete drafts[kind]
    } else {
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_PUBLISH_DRAFT_BYTES) {
        throw new Error('That draft is too large to keep')
      }
      drafts[kind] = value
    }
    if (Object.keys(drafts).length === 0) {
      rmSync(this.filePath, { force: true })
      return
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(drafts)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Best effort: some filesystems do not implement POSIX modes.
    }
  }

  private read(): Drafts {
    if (!existsSync(this.filePath)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as Drafts) : {}
    } catch (error) {
      console.warn('[publish-drafts] ignoring an unreadable file:', error)
      return {}
    }
  }
}

export function registerPublishDraftIpc(store: PublishDraftStore): void {
  ipcMain.handle('ncc:publish-draft-load', (event, kind: unknown) => {
    requireChrome(event, 'Publishing drafts')
    return isKind(kind) ? store.load(kind) : null
  })
  ipcMain.handle('ncc:publish-draft-save', (event, kind: unknown, value: unknown) => {
    requireChrome(event, 'Publishing drafts')
    if (isKind(kind)) store.save(kind, value)
  })
}
