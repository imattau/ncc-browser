import { randomUUID } from 'node:crypto'
import type { Event } from 'nostr-tools'
import {
  PASSWORD_VAULT_D,
  PASSWORD_VAULT_KIND,
  activeEntries,
  isVaultWithinLimit,
  vaultByteLength,
  type PasswordExportResult,
  type PasswordImportPreview,
  type PasswordSaveResult,
  type PasswordVault,
  type PasswordVaultStatus
} from '@shared/passwords'
import type { PasswordCache, CachedVault } from './cache'
import { messageOf } from './errors'
import { exportPasswordCsv, parsePasswordCsv, previewRows, type ImportedRow } from './import-export'
import type { PasswordFileDialogs, ProviderLike } from './service'
import {
  VAULT_ERROR,
  applyRows,
  applyVaultImport,
  emptyVault,
  parseEvent,
  toRow
} from './vault-ops'

interface PendingImport {
  kind: 'rows' | 'vault'
  rows?: ImportedRow[]
  vault?: PasswordVault
  createdAt: number
}

export interface TransferContext {
  unlocked: () => boolean
  vault: () => PasswordVault | null
  pubkey: () => string | null
  now: () => number
  dialogs: PasswordFileDialogs
  cache: PasswordCache
  requireProvider: () => ProviderLike
  decryptEvent: (provider: ProviderLike, event: Event) => Promise<PasswordVault>
  ensureLatest: (provider: ProviderLike, pubkey: string) => Promise<void>
  commit: (provider: ProviderLike, pubkey: string, next: PasswordVault) => Promise<PasswordSaveResult>
  status: () => PasswordVaultStatus
  sendToast: (toast: { tone: 'ok' | 'warn' | 'error'; message: string }) => void
}

const LOCKED = 'Unlock the password manager first'

/** CSV/encrypted-JSON import and export, including the pre-commit preview cache. */
export class PasswordTransfer {
  private readonly imports = new Map<string, PendingImport>()

  constructor(private readonly ctx: TransferContext) {}

  async importOpen(): Promise<PasswordImportPreview> {
    const vault = this.ctx.vault()
    if (!this.ctx.unlocked() || !vault) {
      return {
        id: '',
        format: 'chrome',
        count: 0,
        duplicates: 0,
        projectedBytes: 0,
        entries: [],
        error: LOCKED
      }
    }
    const file = await this.ctx.dialogs.open()
    if (!file) {
      return {
        id: '',
        cancelled: true,
        format: 'chrome',
        count: 0,
        duplicates: 0,
        projectedBytes: 0,
        entries: []
      }
    }
    try {
      const format = file.path.toLowerCase().endsWith('.json') ? 'encrypted' : 'csv'
      if (format === 'encrypted') {
        const event = parseEvent(file.text)
        if (event.pubkey !== this.ctx.pubkey()) {
          throw new Error('That vault belongs to a different identity')
        }
        const imported = await this.ctx.decryptEvent(this.ctx.requireProvider(), event)
        const current = this.ctx.vault()
        if (!current) throw new Error(VAULT_ERROR)
        const rows = activeEntries(imported).map(toRow)
        const next = applyRows(current, rows, this.ctx.now(), 'merge')
        const preview = previewRows(
          randomUUID(),
          'encrypted',
          rows,
          activeEntries(current),
          vaultByteLength(next)
        )
        this.imports.set(preview.id, {
          kind: 'vault',
          vault: imported,
          createdAt: this.ctx.now()
        })
        return preview
      }
      const parsed = parsePasswordCsv(file.text)
      const current = this.ctx.vault()
      if (!current) throw new Error(VAULT_ERROR)
      const next = applyRows(current, parsed.rows, this.ctx.now(), 'merge')
      const preview = previewRows(
        randomUUID(),
        parsed.format,
        parsed.rows,
        activeEntries(current),
        vaultByteLength(next),
        parsed.skipped
      )
      this.imports.set(preview.id, {
        kind: 'rows',
        rows: parsed.rows,
        createdAt: this.ctx.now()
      })
      return preview
    } catch (error) {
      return {
        id: '',
        format: 'chrome',
        count: 0,
        duplicates: 0,
        projectedBytes: 0,
        entries: [],
        error: messageOf(error)
      }
    }
  }

  async importCommit(id: string, mode: 'merge' | 'skip' | 'add'): Promise<PasswordSaveResult> {
    const vault = this.ctx.vault()
    const pubkey = this.ctx.pubkey()
    if (!this.ctx.unlocked() || !vault || !pubkey) return { ok: false, error: LOCKED }
    const pending = this.imports.get(id)
    if (!pending) return { ok: false, error: 'That import expired' }
    this.imports.delete(id)
    try {
      const provider = this.ctx.requireProvider()
      await this.ctx.ensureLatest(provider, pubkey)
      const current = this.ctx.vault() ?? emptyVault()
      let next: PasswordVault
      if (pending.kind === 'vault' && pending.vault) {
        next = applyVaultImport(current, pending.vault, this.ctx.now(), mode)
      } else {
        next = applyRows(current, pending.rows ?? [], this.ctx.now(), mode)
      }
      if (!isVaultWithinLimit(next)) {
        return {
          ok: false,
          error: `The imported vault would exceed ${Math.round(vaultByteLength(next) / 1024)} KB; remove entries or import in smaller batches.`,
          status: this.ctx.status()
        }
      }
      const result = await this.ctx.commit(provider, pubkey, next)
      if (result.ok) this.ctx.sendToast({ tone: 'ok', message: 'Password vault imported.' })
      return result
    } catch (error) {
      return { ok: false, error: messageOf(error), status: this.ctx.status() }
    }
  }

  async export(format: 'encrypted' | 'csv'): Promise<PasswordExportResult> {
    const vault = this.ctx.vault()
    const pubkey = this.ctx.pubkey()
    if (!this.ctx.unlocked() || !vault || !pubkey) return { ok: false, error: LOCKED }
    const stamp = new Date(this.ctx.now()).toISOString().slice(0, 10)
    try {
      if (format === 'csv') {
        const data = exportPasswordCsv(activeEntries(vault))
        const path = await this.ctx.dialogs.save(`ncc-passwords-${stamp}.csv`, data)
        return path ? { ok: true, path } : { ok: false, error: 'Export cancelled' }
      }
      const provider = this.ctx.requireProvider()
      const cached: CachedVault | null = this.ctx.cache.get(pubkey)
      let event = cached?.event
      if (!event) {
        const result = await this.ctx.commit(provider, pubkey, vault)
        if (!result.ok) return { ok: false, error: result.error }
        event = this.ctx.cache.get(pubkey)?.event
      }
      if (!event) return { ok: false, error: 'The vault has not been published yet' }
      const path = await this.ctx.dialogs.save(
        `ncc-passwords-${stamp}.json`,
        `${JSON.stringify(event, null, 2)}\n`
      )
      return path ? { ok: true, path } : { ok: false, error: 'Export cancelled' }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }
}
