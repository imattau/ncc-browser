import { randomBytes, randomUUID } from 'node:crypto'
import {
  verifyEvent,
  type Event,
  type EventTemplate,
  type Filter
} from 'nostr-tools'
import {
  PASSWORD_VAULT_CLIENT,
  PASSWORD_VAULT_D,
  PASSWORD_VAULT_KIND,
  PASSWORD_VAULT_TAG,
  PASSWORD_VAULT_VERSION,
  activeEntries,
  canUsePasswordOrigin,
  entriesForOrigin,
  findEntry,
  findEntryFor,
  isPlaintextNcc,
  isVaultWithinLimit,
  mergeVaults,
  normalizeImportedOrigin,
  normalizeVault,
  pageOriginFromUrl,
  passwordVaultFilter,
  summarizeVault,
  vaultByteLength,
  type PasswordVault
} from '@shared/passwords'
import type {
  AppConfig,
  IdentityStatus,
  PasswordConfig,
  PasswordContext,
  PasswordCopyResult,
  PasswordDraft,
  PasswordEntry,
  PasswordExportResult,
  PasswordFillResult,
  PasswordGeneratorOptions,
  PasswordImportPreview,
  PasswordPage,
  PasswordRelaySource,
  PasswordSaveRequest,
  PasswordSaveResult,
  PasswordSummary,
  PasswordToast,
  PasswordTotpCode,
  PasswordVaultStatus
} from '@shared/types'
import type { PasswordCache, CachedVault } from './cache'
import { generatePassword } from './generator'
import {
  exportPasswordCsv,
  parsePasswordCsv,
  previewRows,
  type ImportedRow
} from './import-export'
import { discoverWriteRelays } from '../relay/nip65'
import { normalizeTotpInput, totpFor } from './totp'

export interface ProviderLike {
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<Event>
  nip44Encrypt(peer: string, plaintext: string): Promise<string>
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>
}

export interface PasswordIdentityLike {
  status(): IdentityStatus
  provider(): ProviderLike | null
}

export interface PasswordConfigStoreLike {
  get(): AppConfig
  getRelays(): string[]
  setPasswordConfig(input: unknown): AppConfig
  addNeverSave(origin: string): AppConfig
  removeNeverSave(origin: string): AppConfig
}

export interface PasswordRelayPoolLike {
  query(relays: string[], filter: Filter): Promise<Event[]>
  queryAuth(
    relays: string[],
    filter: Filter,
    onauth?: (event: EventTemplate) => Promise<Event>
  ): Promise<Event[]>
  publishWithAuth(
    url: string,
    event: Event,
    onauth?: (event: EventTemplate) => Promise<Event>
  ): Promise<string>
}

export interface PasswordHost {
  activePage(): PasswordPage | null
  pageForTab(tabId: string): PasswordPage | null
  tabIdForContents(webContentsId: number): string | null
  sendToChrome(channel: string, payload?: unknown): boolean
  sendToContent(tabId: string, channel: string, payload: unknown): boolean
}

export interface PasswordClipboard {
  writeText(value: string): void
  readText(): Promise<string>
  clear(): void
}

export interface PasswordFileDialogs {
  open(): Promise<{ path: string; text: string } | null>
  save(defaultName: string, data: string): Promise<string | null>
}

export interface PasswordServiceDeps {
  config: PasswordConfigStoreLike
  identity: PasswordIdentityLike
  relays: PasswordRelayPoolLike
  cache: PasswordCache
  host: PasswordHost
  clipboard: PasswordClipboard
  dialogs: PasswordFileDialogs
  now?: () => number
}

interface PendingSave {
  request: PasswordSaveRequest
  password: string
  tabId: string
  expires: number
}

interface PendingImport {
  kind: 'rows' | 'vault'
  rows?: ImportedRow[]
  vault?: PasswordVault
  createdAt: number
}

interface FillWaiter {
  resolve: (result: PasswordFillResult) => void
  timer: NodeJS.Timeout
}

const VAULT_ERROR = 'The password vault could not be read'
const LOCKED = 'Unlock the password manager first'
const MAX_EVENT_CONTENT = 1_000_000

export class PasswordService {
  private readonly now: () => number
  private unlocked = false
  private pubkey: string | null = null
  private vault: PasswordVault | null = null
  private cached: CachedVault | null = null
  private lastCreatedAt = 0
  private lastSyncedAt: number | null = null
  private pending = false
  private syncing = false
  private error: string | null = null
  private resolvedRelays: string[] | null = null
  private relaySource: PasswordRelaySource = 'browser'
  private lockTimer: NodeJS.Timeout | null = null
  private readonly pendingSaves = new Map<string, PendingSave>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  private readonly fillWaiters = new Map<string, FillWaiter>()
  private readonly imports = new Map<string, PendingImport>()
  private readonly formState = new Map<string, { hasLoginForm: boolean; title: string }>()

  constructor(private readonly deps: PasswordServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  status(): PasswordVaultStatus {
    const identity = this.deps.identity.status()
    const provider = this.deps.identity.provider()
    const config = this.deps.config.get().passwords
    const fallback = this.defaultRelays(config)
    return {
      configured: identity.configured && provider != null,
      available: provider != null,
      unlocked: this.unlocked,
      entryCount: this.vault ? activeEntries(this.vault).length : 0,
      pending: this.pending,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      relays: this.resolvedRelays ?? fallback.urls,
      relaySource: this.resolvedRelays ? this.relaySource : fallback.source,
      mode: identity.mode,
      error: this.error,
      autoLockMinutes: config.autoLockMinutes,
      offerSave: config.offerSave,
      useNip65: config.useNip65,
      vaultRelay: config.vaultRelay,
      neverSave: config.neverSave
    }
  }

  context(): PasswordContext {
    const page = this.deps.host.activePage()
    const usable = page != null && page.mode !== 'blank' && page.mode !== 'error'
    const info = usable ? pageOriginFromUrl(page.url) : null
    const status = this.status()
    const matches =
      this.unlocked && this.vault && info && page?.kind !== 'private'
        ? entriesForOrigin(this.vault, info.origin).map(summary)
        : []
    const form = page ? this.formState.get(page.tabId) : undefined
    const locked = !this.unlocked
    const plaintext = isPlaintextNcc(page)

    let warning: string | null = null
    if (page?.kind === 'private') {
      warning = 'Passwords are unavailable in private tabs.'
    } else if (info?.scheme === 'http') {
      warning = 'Passwords are disabled on insecure pages.'
    } else if (plaintext) {
      warning =
        'This NCC page is served over HTTP. The npub authenticates the locator, not the page content.'
    } else if (page?.kind === 'tor') {
      warning = 'Filling works in Tor tabs, but saving new logins is disabled.'
    }

    return {
      origin: info?.origin ?? null,
      title: page?.title ?? '',
      secure: info ? info.secure && !plaintext : false,
      scheme: info?.scheme ?? null,
      tabKind: page?.kind ?? 'normal',
      locked,
      configured: status.configured,
      status,
      matches,
      formDetected: form?.hasLoginForm ?? false,
      pendingSave: this.pendingForOrigin(info?.origin ?? null),
      canFill:
        status.configured &&
        !locked &&
        usable &&
        page?.kind !== 'private' &&
        !!info &&
        canUsePasswordOrigin(info) &&
        matches.length > 0,
      canSave:
        status.configured &&
        usable &&
        page?.kind === 'normal' &&
        !!info &&
        canUsePasswordOrigin(info) &&
        info.scheme !== 'http',
      warning
    }
  }

  async unlock(): Promise<PasswordVaultStatus> {
    const provider = this.deps.identity.provider()
    if (!provider) {
      this.error = 'Set up a Nostr identity to use the password manager.'
      this.sendStatus()
      return this.status()
    }

    let pubkey: string
    try {
      pubkey = await provider.getPublicKey()
    } catch (error) {
      this.error = messageOf(error)
      this.sendStatus()
      return this.status()
    }

    if (this.unlocked && this.pubkey === pubkey) {
      this.touch()
      return this.status()
    }

    this.lockInternal(false)
    this.pubkey = pubkey
    this.cached = this.deps.cache.get(pubkey)
    this.lastCreatedAt = this.cached?.event.created_at ?? 0
    this.lastSyncedAt = this.cached?.syncedAt ?? null
    this.pending = this.cached?.pending ?? false
    this.error = null

    if (this.cached) {
      try {
        this.vault = await this.decryptEvent(provider, this.cached.event)
      } catch {
        this.vault = emptyVault()
        this.error = 'The local vault could not be decrypted. Fetching the relay copy.'
      }
    } else {
      this.vault = emptyVault()
    }

    this.unlocked = true
    this.scheduleLock()
    this.sendStatus()

    try {
      await this.sync(provider, true)
      this.error = null
    } catch (error) {
      this.error = messageOf(error)
    }
    this.touch()
    this.sendStatus()
    this.sendContext()
    return this.status()
  }

  lock(): PasswordVaultStatus {
    this.lockInternal(true)
    return this.status()
  }

  onIdentityChanged(): void {
    this.lockInternal(true)
    this.error = null
    this.resolvedRelays = null
    this.sendStatus()
    this.sendContext()
  }

  dispose(): void {
    this.lockInternal(false)
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    for (const waiter of this.fillWaiters.values()) clearTimeout(waiter.timer)
    this.fillWaiters.clear()
  }

  list(): PasswordSummary[] {
    if (!this.unlocked || !this.vault) return []
    this.touch()
    return summarizeVault(this.vault)
  }

  entry(id: string): PasswordEntry | null {
    if (!this.unlocked || !this.vault) throw new Error(LOCKED)
    this.touch()
    return findEntry(this.vault, id)
  }

  reveal(id: string): string {
    if (!this.unlocked || !this.vault) throw new Error(LOCKED)
    const entry = findEntry(this.vault, id)
    if (!entry || entry.deleted) throw new Error('That login no longer exists')
    this.touch()
    return entry.password
  }

  totp(id: string): PasswordTotpCode {
    if (!this.unlocked || !this.vault) throw new Error(LOCKED)
    const entry = findEntry(this.vault, id)
    if (!entry || entry.deleted) throw new Error('That login no longer exists')
    if (!entry.totp) throw new Error('This login has no 2FA secret')
    this.touch()
    return totpFor(entry.totp, this.now())
  }

  copy(id: string, field: 'username' | 'password' | 'totp'): PasswordCopyResult {
    if (!this.unlocked || !this.vault) throw new Error(LOCKED)
    const entry = findEntry(this.vault, id)
    if (!entry || entry.deleted) throw new Error('That login no longer exists')
    if (field === 'totp' && !entry.totp) throw new Error('This login has no 2FA secret')
    const value =
      field === 'username'
        ? entry.username
        : field === 'totp'
          ? totpFor(entry.totp, this.now()).code
          : entry.password
    if (!value) throw new Error(`This login has no ${field}`)
    this.deps.clipboard.writeText(value)
    this.touch()
    let clearsAt: number | undefined
    if (field !== 'username') {
      clearsAt = this.now() + 30_000
      const timer = setTimeout(() => {
        void this.deps.clipboard
          .readText()
          .then((current) => {
            if (current === value) this.deps.clipboard.clear()
          })
          .catch(() => undefined)
      }, 30_000)
      timer.unref?.()
    }
    return { ok: true, ...(clearsAt ? { clearsAt } : {}) }
  }

  generate(options: PasswordGeneratorOptions): string {
    this.touch()
    return generatePassword(options)
  }

  async saveEntry(input: PasswordDraft): Promise<PasswordSaveResult> {
    if (!this.unlocked || !this.vault || !this.pubkey) return { ok: false, error: LOCKED }
    try {
      const provider = this.requireProvider()
      const entry = this.normalizeDraft(input)
      await this.ensureLatest(provider, this.pubkey)
      const current = this.vault ?? emptyVault()
      const next = applyEntry(current, entry)
      const result = await this.commit(provider, this.pubkey, next)
      this.touch()
      return result
    } catch (error) {
      this.error = messageOf(error)
      this.sendStatus()
      return { ok: false, error: this.error, status: this.status() }
    }
  }

  async removeEntry(id: string): Promise<PasswordSaveResult> {
    if (!this.unlocked || !this.vault || !this.pubkey) return { ok: false, error: LOCKED }
    try {
      const entry = findEntry(this.vault, id)
      if (!entry || entry.deleted) return { ok: false, error: 'That login no longer exists' }
      const provider = this.requireProvider()
      await this.ensureLatest(provider, this.pubkey)
      const current = this.vault ?? emptyVault()
      const next = applyEntry(current, { ...entry, deleted: true, updatedAt: this.now() })
      return await this.commit(provider, this.pubkey, next)
    } catch (error) {
      this.error = messageOf(error)
      this.sendStatus()
      return { ok: false, error: this.error, status: this.status() }
    }
  }

  /** Background sync when the window regains focus, throttled to once per 30s. */
  async onWindowFocus(): Promise<void> {
    if (!this.unlocked || this.syncing) return
    if (this.lastSyncedAt && this.now() - this.lastSyncedAt < 30_000) return
    await this.syncNow()
  }

  async syncNow(): Promise<PasswordVaultStatus> {
    if (!this.unlocked) return this.status()
    try {
      await this.sync(this.requireProvider(), true)
      this.error = null
      this.touch()
    } catch (error) {
      this.error = messageOf(error)
    }
    this.sendStatus()
    this.sendContext()
    return this.status()
  }

  async fill(id: string): Promise<PasswordFillResult> {
    if (!this.unlocked || !this.vault) return { ok: false, error: LOCKED }
    const page = this.deps.host.activePage()
    if (!page) return { ok: false, error: 'There is no active page' }
    if (page.kind === 'private') return { ok: false, error: 'Passwords are unavailable in private tabs' }
    const info = pageOriginFromUrl(page.url)
    if (!info || !canUsePasswordOrigin(info)) {
      return { ok: false, error: 'Passwords are disabled on this page' }
    }
    const entry = findEntry(this.vault, id)
    if (!entry || entry.deleted) return { ok: false, error: 'That login no longer exists' }
    if (entry.origin !== info.origin) {
      return { ok: false, error: 'That login belongs to a different site' }
    }

    const requestId = randomUUID()
    const result = new Promise<PasswordFillResult>((resolve) => {
      const timer = setTimeout(() => {
        this.fillWaiters.delete(requestId)
        resolve({ ok: false, error: 'The page did not accept the login' })
      }, 5_000)
      timer.unref?.()
      this.fillWaiters.set(requestId, { resolve, timer })
    })

    const sent = this.deps.host.sendToContent(page.tabId, 'passwords:fill', {
      requestId,
      username: entry.username,
      password: entry.password
    })
    if (!sent) {
      const waiter = this.fillWaiters.get(requestId)
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: false, error: 'The page is no longer available' })
        this.fillWaiters.delete(requestId)
      }
    }
    this.touch()
    return result
  }

  handleFillResult(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const value = payload as { requestId?: unknown; ok?: unknown; error?: unknown }
    if (typeof value.requestId !== 'string') return
    const waiter = this.fillWaiters.get(value.requestId)
    if (!waiter) return
    this.fillWaiters.delete(value.requestId)
    clearTimeout(waiter.timer)
    waiter.resolve({
      ok: value.ok === true,
      ...(typeof value.error === 'string' ? { error: value.error } : {})
    })
  }

  handleFormState(webContentsId: number, payload: unknown): void {
    const tabId = this.deps.host.tabIdForContents(webContentsId)
    if (!tabId) return
    const page = this.deps.host.pageForTab(tabId)
    if (!page || page.kind === 'private') return
    const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    this.formState.set(tabId, {
      hasLoginForm: value.hasLoginForm === true,
      title: typeof value.title === 'string' ? value.title.slice(0, 200) : ''
    })
    if (this.deps.host.activePage()?.tabId === tabId) this.sendContext()
  }

  handleCapture(webContentsId: number, payload: unknown): void {
    const tabId = this.deps.host.tabIdForContents(webContentsId)
    if (!tabId) return
    const page = this.deps.host.pageForTab(tabId)
    if (!page || page.mode === 'blank' || page.mode === 'error') return
    if (page.kind !== 'normal') return

    const info = pageOriginFromUrl(page.url)
    if (!info || !canUsePasswordOrigin(info) || info.scheme === 'http') return
    const config = this.deps.config.get().passwords
    if (!config.offerSave || config.neverSave.includes(info.origin)) return
    if (!this.deps.identity.provider()) return

    const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const username = typeof value.username === 'string' ? value.username.trim().slice(0, 320) : ''
    const password = typeof value.password === 'string' ? value.password.slice(0, 4096) : ''
    if (!password) return
    const title =
      (typeof value.title === 'string' ? value.title.trim().slice(0, 200) : '') || info.origin

    const duplicate = [...this.pendingSaves.values()].some(
      (pending) =>
        pending.request.origin === info.origin &&
        pending.request.username === username &&
        pending.password === password &&
        pending.expires > this.now()
    )
    if (duplicate) return

    const existing =
      this.unlocked && this.vault ? findEntryFor(this.vault, info.origin, username) : null
    if (existing && existing.password === password) return

    const id = randomUUID()
    const request: PasswordSaveRequest = {
      id,
      origin: info.origin,
      title,
      username,
      mode: existing ? 'update' : 'create',
      ...(existing ? { existingId: existing.id } : {}),
      secure: info.secure && !isPlaintextNcc(page),
      tabKind: page.kind,
      locked: !this.unlocked
    }
    const timer = setTimeout(() => this.clearSave(id), 120_000)
    timer.unref?.()
    this.saveTimers.set(id, timer)
    this.pendingSaves.set(id, {
      request,
      password,
      tabId,
      expires: this.now() + 120_000
    })
    this.deps.host.sendToChrome('ncc:password-save-request', request)
    this.sendContext()
  }

  async respondToSave(
    id: string,
    action: 'save' | 'never' | 'dismiss'
  ): Promise<PasswordSaveResult> {
    const pending = this.pendingSaves.get(id)
    if (!pending) return { ok: false, error: 'That save request expired' }
    this.clearSave(id)

    if (action === 'dismiss') {
      this.sendContext()
      return { ok: true, status: this.status() }
    }
    if (action === 'never') {
      this.deps.config.addNeverSave(pending.request.origin)
      this.sendStatus()
      this.sendContext()
      return { ok: true, status: this.status() }
    }

    if (!this.unlocked) {
      const status = await this.unlock()
      if (!status.unlocked) return { ok: false, error: status.error ?? 'Could not unlock the vault' }
    }
    if (!this.vault) return { ok: false, error: VAULT_ERROR }

    const existing = findEntryFor(this.vault, pending.request.origin, pending.request.username)
    const result = await this.saveEntry({
      ...(existing ? { id: existing.id } : {}),
      origin: pending.request.origin,
      title: existing?.title || pending.request.title,
      username: pending.request.username,
      password: pending.password,
      notes: existing?.notes ?? '',
      totp: existing?.totp ?? ''
    })
    if (result.ok) {
      this.sendToast({
        tone: result.pending ? 'warn' : 'ok',
        message: result.pending
          ? 'Login saved locally; relay sync will retry.'
          : existing
            ? 'Password updated.'
            : 'Login saved.'
      })
    }
    this.sendContext()
    return result
  }

  async setConfig(input: Partial<PasswordConfig>): Promise<PasswordVaultStatus> {
    if (typeof input.vaultRelay === 'string' && input.vaultRelay.trim()) {
      if (!/^wss?:\/\//i.test(input.vaultRelay.trim())) {
        this.error = 'The vault relay must start with ws:// or wss://'
        this.sendStatus()
        return this.status()
      }
    }
    this.deps.config.setPasswordConfig(input)
    this.error = null
    if (this.unlocked) this.scheduleLock()
    if (input.vaultRelay !== undefined || input.useNip65 !== undefined) {
      this.resolvedRelays = null
    }
    this.sendStatus()
    this.sendContext()
    return this.status()
  }

  /** Called by the identity settings when the user removes a never-save origin. */
  removeNeverSave(origin: string): void {
    this.deps.config.removeNeverSave(origin)
    this.sendStatus()
    this.sendContext()
  }

  async importOpen(): Promise<PasswordImportPreview> {
    if (!this.unlocked || !this.vault) {
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
    const file = await this.deps.dialogs.open()
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
        if (event.pubkey !== this.pubkey) throw new Error('That vault belongs to a different identity')
        const imported = await this.decryptEvent(this.requireProvider(), event)
        const rows = activeEntries(imported).map(toRow)
        const next = applyRows(this.vault, rows, this.now(), 'merge')
        const preview = previewRows(
          randomUUID(),
          'encrypted',
          rows,
          activeEntries(this.vault),
          vaultByteLength(next)
        )
        this.imports.set(preview.id, { kind: 'vault', vault: imported, createdAt: this.now() })
        return preview
      }
      const parsed = parsePasswordCsv(file.text)
      const next = applyRows(this.vault, parsed.rows, this.now(), 'merge')
      const preview = previewRows(
        randomUUID(),
        parsed.format,
        parsed.rows,
        activeEntries(this.vault),
        vaultByteLength(next),
        parsed.skipped
      )
      this.imports.set(preview.id, { kind: 'rows', rows: parsed.rows, createdAt: this.now() })
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

  async importCommit(
    id: string,
    mode: 'merge' | 'skip' | 'add'
  ): Promise<PasswordSaveResult> {
    if (!this.unlocked || !this.vault || !this.pubkey) return { ok: false, error: LOCKED }
    const pending = this.imports.get(id)
    if (!pending) return { ok: false, error: 'That import expired' }
    this.imports.delete(id)
    try {
      const provider = this.requireProvider()
      await this.ensureLatest(provider, this.pubkey)
      const current = this.vault ?? emptyVault()
      let next: PasswordVault
      if (pending.kind === 'vault' && pending.vault) {
        next = applyVaultImport(current, pending.vault, this.now(), mode)
      } else {
        next = applyRows(current, pending.rows ?? [], this.now(), mode)
      }
      if (!isVaultWithinLimit(next)) {
        return {
          ok: false,
          error: `The imported vault would exceed ${Math.round(vaultByteLength(next) / 1024)} KB; remove entries or import in smaller batches.`,
          status: this.status()
        }
      }
      const result = await this.commit(provider, this.pubkey, next)
      if (result.ok) this.sendToast({ tone: 'ok', message: 'Password vault imported.' })
      return result
    } catch (error) {
      return { ok: false, error: messageOf(error), status: this.status() }
    }
  }

  async export(format: 'encrypted' | 'csv'): Promise<PasswordExportResult> {
    if (!this.unlocked || !this.vault || !this.pubkey) return { ok: false, error: LOCKED }
    const stamp = new Date(this.now()).toISOString().slice(0, 10)
    try {
      if (format === 'csv') {
        const data = exportPasswordCsv(activeEntries(this.vault))
        const path = await this.deps.dialogs.save(`ncc-passwords-${stamp}.csv`, data)
        return path ? { ok: true, path } : { ok: false, error: 'Export cancelled' }
      }
      const provider = this.requireProvider()
      const cached = this.deps.cache.get(this.pubkey)
      let event = cached?.event
      if (!event) {
        const result = await this.commit(provider, this.pubkey, this.vault)
        if (!result.ok) return { ok: false, error: result.error }
        event = this.deps.cache.get(this.pubkey)?.event
      }
      if (!event) return { ok: false, error: 'The vault has not been published yet' }
      const path = await this.deps.dialogs.save(
        `ncc-passwords-${stamp}.json`,
        `${JSON.stringify(event, null, 2)}\n`
      )
      return path ? { ok: true, path } : { ok: false, error: 'Export cancelled' }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** Clear any pending chrome save request when the chrome renderer reloads. */
  clearOverlays(): void {
    for (const id of [...this.pendingSaves.keys()]) this.clearSave(id)
    this.sendContext()
  }

  private async sync(provider: ProviderLike, refreshRelays: boolean): Promise<void> {
    if (!this.unlocked || !this.pubkey || !this.vault) throw new Error(LOCKED)
    const pubkey = this.pubkey
    this.syncing = true
    this.sendStatus()
    try {
      const relays = await this.resolveRelays(pubkey, refreshRelays)
      const remote = await this.fetchRemote(provider, pubkey, relays)
      let next = this.vault

      if (remote) {
        const cachedId = this.cached?.event.id
        if (remote.id !== cachedId || this.cached?.pending) {
          const remoteVault = await this.decryptEvent(provider, remote)
          const merged = mergeVaults(this.vault, remoteVault)
          next = merged.vault
          if (hasLocalChanges(this.vault, remoteVault) || this.cached?.pending) {
            const published = await this.publish(provider, pubkey, next, relays)
            this.vault = next
            this.pending = published.pending
            this.lastSyncedAt = this.now()
            this.error = published.pending
              ? (published.error ?? 'The vault is saved locally but relay sync failed.')
              : null
            this.sendStatus()
            return
          }
          this.cached = { event: remote, pending: false, syncedAt: this.now() }
          this.deps.cache.set(pubkey, this.cached)
          this.lastCreatedAt = Math.max(this.lastCreatedAt, remote.created_at)
        }
        this.vault = next
        this.lastSyncedAt = this.now()
        this.pending = false
        this.error = null
        this.sendStatus()
        return
      }

      if (this.vault.entries.length > 0 || this.cached?.pending) {
        const published = await this.publish(provider, pubkey, this.vault, relays)
        this.pending = published.pending
        this.lastSyncedAt = this.now()
        this.error = published.pending
          ? (published.error ?? 'The vault is saved locally but relay sync failed.')
          : null
      } else {
        this.lastSyncedAt = this.now()
        this.pending = false
        this.error = null
      }
      this.sendStatus()
    } finally {
      this.syncing = false
      this.sendStatus()
    }
  }

  private async commit(
    provider: ProviderLike,
    pubkey: string,
    next: PasswordVault
  ): Promise<PasswordSaveResult> {
    if (!isVaultWithinLimit(next)) {
      throw new Error(
        `The vault would exceed ${Math.round(vaultByteLength(next) / 1024)} KB. Remove entries or shorten notes.`
      )
    }
    const relays = await this.resolveRelays(pubkey, false)
    const published = await this.publish(provider, pubkey, next, relays)
    this.vault = next
    this.pending = published.pending
    this.lastSyncedAt = this.now()
    this.error = published.pending ? 'The vault is saved locally but no relay accepted it.' : null
    this.sendStatus()
    this.sendContext()
    return {
      ok: true,
      ...(published.pending ? { pending: true } : {}),
      ...(published.pending ? { error: published.error } : {}),
      status: this.status()
    }
  }

  private async ensureLatest(provider: ProviderLike, pubkey: string): Promise<void> {
    const relays = await this.resolveRelays(pubkey, false)
    const remote = await this.fetchRemote(provider, pubkey, relays).catch(() => null)
    if (!remote) return
    const cachedId = this.cached?.event.id
    if (remote.id === cachedId) return
    if (this.cached && remote.created_at < this.cached.event.created_at) return
    const local = this.vault ?? emptyVault()
    const remoteVault = await this.decryptEvent(provider, remote)
    const merged = mergeVaults(local, remoteVault)
    this.vault = merged.vault
    this.lastCreatedAt = Math.max(this.lastCreatedAt, remote.created_at)
    if (hasLocalChanges(local, remoteVault)) return
    this.cached = { event: remote, pending: false, syncedAt: this.now() }
    this.deps.cache.set(pubkey, this.cached)
  }

  private async publish(
    provider: ProviderLike,
    pubkey: string,
    vault: PasswordVault,
    relays: string[]
  ): Promise<{ pending: boolean; error?: string; event: Event }> {
    if (relays.length === 0) throw new Error('No vault relay is configured')
    if (!isVaultWithinLimit(vault)) {
      throw new Error(
        `The vault would exceed ${Math.round(vaultByteLength(vault) / 1024)} KB. Remove entries or shorten notes.`
      )
    }
    const plaintext = JSON.stringify(vault)
    const content = await provider.nip44Encrypt(pubkey, plaintext)
    const created_at = Math.max(Math.floor(this.now() / 1000), this.lastCreatedAt + 1)
    const event = await provider.signEvent({
      kind: PASSWORD_VAULT_KIND,
      created_at,
      tags: [
        ['d', PASSWORD_VAULT_D],
        ['t', PASSWORD_VAULT_TAG],
        ['client', PASSWORD_VAULT_CLIENT]
      ],
      content
    })
    if (!verifyEvent(event)) throw new Error('The signer returned an invalid vault event')
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    const results = await Promise.allSettled(
      relays.map((url) => this.deps.relays.publishWithAuth(url, event, onauth))
    )
    const accepted = results.filter((result) => result.status === 'fulfilled').length
    const pending = accepted < relays.length
    this.lastCreatedAt = event.created_at
    this.cached = {
      event,
      pending,
      syncedAt: this.now()
    }
    this.deps.cache.set(pubkey, this.cached)
    this.pending = pending
    return {
      pending,
      event,
      ...(pending
        ? {
            error:
              accepted === 0
                ? `No relay accepted the vault (${relays.length} tried)`
                : `${relays.length - accepted} of ${relays.length} relays did not accept the vault`
          }
        : {})
    }
  }

  /**
   * New vault events replace the previous addressable event, but relays that were
   * offline during a save keep the old copy; the next sync republishes the merged
   * vault once those relays are reachable.
   */
  private async fetchRemote(
    provider: ProviderLike,
    pubkey: string,
    relays: string[]
  ): Promise<Event | null> {
    if (relays.length === 0) return null
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    const events = await this.deps.relays.queryAuth(
      relays,
      passwordVaultFilter(pubkey),
      onauth
    )
    const valid = events
      .filter(
        (event) =>
          event.kind === PASSWORD_VAULT_KIND &&
          event.pubkey === pubkey &&
          event.content.length <= MAX_EVENT_CONTENT &&
          event.tags.some((tag) => tag[0] === 'd' && tag[1] === PASSWORD_VAULT_D) &&
          verifyEvent(event)
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    return valid[0] ?? null
  }

  private async decryptEvent(provider: ProviderLike, event: Event): Promise<PasswordVault> {
    if (!this.pubkey) throw new Error(VAULT_ERROR)
    const plaintext = await provider.nip44Decrypt(this.pubkey, event.content)
    let parsed: unknown
    try {
      parsed = JSON.parse(plaintext)
    } catch {
      throw new Error('The decrypted vault is not valid JSON')
    }
    const version =
      parsed && typeof parsed === 'object' ? (parsed as { v?: unknown }).v : undefined
    if (version !== PASSWORD_VAULT_VERSION) {
      throw new Error('This vault was created by a newer version of Nostr Navigator')
    }
    return normalizeVault(parsed)
  }

  private signAuth(provider: ProviderLike, template: EventTemplate): Promise<Event> {
    if (template.kind !== 22242) {
      return Promise.reject(new Error('Unexpected AUTH event kind'))
    }
    return this.signAndVerify(provider, template)
  }

  private async signAndVerify(provider: ProviderLike, template: EventTemplate): Promise<Event> {
    const event = await provider.signEvent(template)
    if (!verifyEvent(event)) throw new Error('The signer returned an invalid AUTH event')
    return event
  }

  private requireProvider(): ProviderLike {
    const provider = this.deps.identity.provider()
    if (!provider) throw new Error('Set up a Nostr identity to use the password manager.')
    return provider
  }

  private async resolveRelays(pubkey: string, force: boolean): Promise<string[]> {
    if (this.resolvedRelays && !force) return this.resolvedRelays
    const config = this.deps.config.get().passwords
    if (config.vaultRelay) {
      this.resolvedRelays = [trimRelay(config.vaultRelay)]
      this.relaySource = 'dedicated'
      return this.resolvedRelays
    }
    const configured = this.deps.config.getRelays()
    if (!config.useNip65) {
      this.resolvedRelays = configured
      this.relaySource = 'browser'
      return configured
    }
    let write: string[] = []
    try {
      write = await discoverWriteRelays(this.deps.relays.query, pubkey, configured)
    } catch {
      write = []
    }
    const urls = [...new Set([...configured, ...write])].slice(0, 12)
    this.resolvedRelays = urls
    this.relaySource = write.length > 0 ? 'browser+nip65' : 'browser'
    return urls
  }

  private defaultRelays(config: PasswordConfig): {
    urls: string[]
    source: PasswordRelaySource
  } {
    if (config.vaultRelay) {
      return { urls: [trimRelay(config.vaultRelay)], source: 'dedicated' }
    }
    return { urls: this.deps.config.getRelays(), source: 'browser' }
  }

  private normalizeDraft(input: PasswordDraft): PasswordEntry {
    const now = this.now()
    const parsed = pageOriginFromUrl(
      input.origin.includes('://') ? input.origin : `https://${input.origin}`
    )
    if (!parsed || !canUsePasswordOrigin(parsed) || parsed.scheme === 'http') {
      throw new Error('Enter an https:// or ncc:// address')
    }
    const existing = input.id && this.vault ? findEntry(this.vault, input.id) : null
    const id = existing?.id ?? randomBytes(8).toString('hex')
    const password = typeof input.password === 'string' ? input.password.slice(0, 4096) : ''
    return {
      id,
      origin: parsed.origin,
      title: (input.title || parsed.origin).trim().slice(0, 200),
      username: (input.username ?? '').trim().slice(0, 320),
      password,
      notes: (input.notes ?? '').trim().slice(0, 4096),
      totp: normalizeTotpInput(input.totp),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  }

  private pendingForOrigin(origin: string | null): boolean {
    if (!origin) return false
    return [...this.pendingSaves.values()].some(
      (pending) => pending.request.origin === origin && pending.expires > this.now()
    )
  }

  private clearSave(id: string): void {
    this.pendingSaves.delete(id)
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
  }

  private lockInternal(notify: boolean): void {
    this.unlocked = false
    this.pubkey = null
    this.vault = null
    this.pendingSaves.clear()
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    for (const waiter of this.fillWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, error: 'The password manager locked' })
    }
    this.fillWaiters.clear()
    if (this.lockTimer) clearTimeout(this.lockTimer)
    this.lockTimer = null
    if (notify) {
      this.sendStatus()
      this.sendContext()
    }
  }

  private scheduleLock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer)
    this.lockTimer = null
    const minutes = this.deps.config.get().passwords.autoLockMinutes
    if (!this.unlocked || minutes <= 0) return
    this.lockTimer = setTimeout(() => this.lock(), minutes * 60_000)
    this.lockTimer.unref?.()
  }

  private touch(): void {
    if (this.unlocked) this.scheduleLock()
  }

  private sendStatus(): void {
    this.deps.host.sendToChrome('ncc:password-status', this.status())
  }

  private sendContext(): void {
    this.deps.host.sendToChrome('ncc:password-context', this.context())
  }

  private sendToast(toast: PasswordToast): void {
    this.deps.host.sendToChrome('ncc:password-toast', toast)
  }
}

function emptyVault(): PasswordVault {
  return { v: PASSWORD_VAULT_VERSION, updatedAt: 0, entries: [] }
}

/** True when the local copy has an entry the remote lacks or a newer version. */
function hasLocalChanges(local: PasswordVault, remote: PasswordVault): boolean {
  for (const entry of local.entries) {
    const match = remote.entries.find((candidate) => candidate.id === entry.id)
    if (!match || entry.updatedAt > match.updatedAt) return true
  }
  return false
}

function summary(entry: PasswordEntry) {
  return {
    id: entry.id,
    origin: entry.origin,
    title: entry.title,
    username: entry.username,
    hasTotp: entry.totp.length > 0,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

function applyEntry(vault: PasswordVault, entry: PasswordEntry): PasswordVault {
  const entries = vault.entries.filter((candidate) => candidate.id !== entry.id)
  entries.push(entry)
  return {
    v: PASSWORD_VAULT_VERSION,
    updatedAt: Math.max(vault.updatedAt, entry.updatedAt),
    entries
  }
}

function toRow(entry: PasswordEntry): ImportedRow {
  return {
    title: entry.title,
    origin: entry.origin,
    username: entry.username,
    password: entry.password,
    notes: entry.notes,
    totp: entry.totp
  }
}

function applyRows(
  vault: PasswordVault,
  rows: ImportedRow[],
  now: number,
  mode: 'merge' | 'skip' | 'add'
): PasswordVault {
  let next = vault
  for (const row of rows) {
    const origin = normalizeImportedOrigin(row.origin)
    if (!origin) continue
    const existing = findEntryFor(next, origin, row.username)
    if (existing && mode !== 'add') {
      if (mode === 'skip') continue
      next = applyEntry(next, {
        ...existing,
        title: row.title || existing.title,
        password: row.password,
        notes: row.notes || existing.notes,
        totp: row.totp ? safeTotp(row.totp) : existing.totp,
        updatedAt: now
      })
      continue
    }
    next = applyEntry(next, {
      id: randomBytes(8).toString('hex'),
      origin,
      title: row.title || origin,
      username: row.username,
      password: row.password,
      notes: row.notes,
      totp: safeTotp(row.totp),
      createdAt: now,
      updatedAt: now
    })
  }
  return next
}

function applyVaultImport(
  vault: PasswordVault,
  imported: PasswordVault,
  now: number,
  mode: 'merge' | 'skip' | 'add'
): PasswordVault {
  let next = vault
  for (const entry of activeEntries(imported)) {
    const existing = findEntryFor(next, entry.origin, entry.username)
    if (existing && mode !== 'add') {
      if (mode === 'skip') continue
      next = applyEntry(next, { ...entry, id: existing.id, createdAt: existing.createdAt, updatedAt: now })
      continue
    }
    next = applyEntry(next, {
      ...entry,
      id: mode === 'add' ? randomBytes(8).toString('hex') : entry.id,
      updatedAt: now
    })
  }
  return next
}

function parseEvent(text: string): Event {
  const parsed = JSON.parse(text) as Partial<Event>
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.kind !== PASSWORD_VAULT_KIND ||
    typeof parsed.pubkey !== 'string' ||
    typeof parsed.content !== 'string' ||
    typeof parsed.created_at !== 'number' ||
    !Array.isArray(parsed.tags) ||
    typeof parsed.sig !== 'string' ||
    typeof parsed.id !== 'string'
  ) {
    throw new Error('That file is not an encrypted password vault')
  }
  const event = parsed as Event
  if (!event.tags.some((tag) => tag[0] === 'd' && tag[1] === PASSWORD_VAULT_D)) {
    throw new Error('That file is not a password vault event')
  }
  if (!verifyEvent(event)) throw new Error('The vault event signature is invalid')
  return event
}

function trimRelay(url: string): string {
  return url.replace(/\/$/, '')
}

function safeTotp(value: string): string {
  try {
    return normalizeTotpInput(value)
  } catch {
    return ''
  }
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}
