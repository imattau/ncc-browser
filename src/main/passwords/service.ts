import { randomBytes, randomUUID } from 'node:crypto'
import { type Event, type EventTemplate, type Filter } from 'nostr-tools'
import {
  activeEntries,
  canUsePasswordOrigin,
  entriesForOrigin,
  findEntry,
  findEntryFor,
  isPlaintextNcc,
  pageOriginFromUrl,
  scanVaultHealth,
  summarizeVault,
  type PasswordVault
} from '@shared/passwords'
import type { AppConfig, IdentityStatus } from '@shared/types'
import type {
  PasswordConfig,
  PasswordContext,
  PasswordCopyResult,
  PasswordDraft,
  PasswordEntry,
  PasswordExportResult,
  PasswordFillResult,
  PasswordGeneratorOptions,
  PasswordHealthReport,
  PasswordImportPreview,
  PasswordPage,
  PasswordSaveRequest,
  PasswordSaveResult,
  PasswordSummary,
  PasswordToast,
  PasswordTotpCode,
  PasswordVaultStatus
} from '@shared/passwords'
import type { PasswordCache } from './cache'
import { generatePassword } from './generator'
import { normalizeTotpInput, totpFor } from './totp'
import type { PasskeyCreationOptions, PasskeyRequestOptions } from './passkeys'
import { PasswordFill } from './fill'
import { PasswordTransfer } from './transfer'
import { messageOf } from './errors'
import { PasswordSync } from './sync'
import { VAULT_ERROR, applyEntry, emptyVault, safeTotp, summary } from './vault-ops'
import {
  canHandleWebauthn,
  hasWebauthnCandidates,
  hasWebauthnCredentials,
  hasWebauthnCredentialsForPage,
  isWebauthnAuthenticatorAvailable,
  webauthnCreate,
  webauthnGet,
  type WebauthnContext
} from './webauthn'

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
  /** Optional: also reports how many relays answered, so a dead relay is not "up to date". */
  queryAuthReport?(
    relays: string[],
    filter: Filter,
    onauth?: (event: EventTemplate) => Promise<Event>
  ): Promise<{ events: Event[]; answered: number }>
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
  onLock?: () => void
  now?: () => number
}

interface PendingSave {
  request: PasswordSaveRequest
  password: string
  tabId: string
  expires: number
}

const LOCKED = 'Unlock the password manager first'

export class PasswordService {
  private readonly now: () => number
  private unlocked = false
  private pubkey: string | null = null
  private vault: PasswordVault | null = null
  private error: string | null = null
  private lockTimer: NodeJS.Timeout | null = null
  private readonly pendingSaves = new Map<string, PendingSave>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  private readonly syncEngine: PasswordSync
  private readonly transfer: PasswordTransfer
  private readonly fillController: PasswordFill
  private readonly webauthnContext: WebauthnContext

  constructor(private readonly deps: PasswordServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.syncEngine = new PasswordSync({
      isUnlocked: () => this.unlocked,
      vault: () => this.vault,
      setVault: (vault) => {
        this.vault = vault
      },
      pubkey: () => this.pubkey,
      setError: (error) => {
        this.error = error
      },
      now: () => this.now(),
      config: deps.config,
      relays: deps.relays,
      cache: deps.cache,
      status: () => this.status(),
      sendStatus: () => this.sendStatus(),
      sendContext: () => this.sendContext()
    })
    this.fillController = new PasswordFill({
      unlocked: () => this.unlocked,
      vault: () => this.vault,
      host: deps.host,
      touch: () => this.touch(),
      sendContext: () => this.sendContext()
    })
    this.transfer = new PasswordTransfer({
      unlocked: () => this.unlocked,
      vault: () => this.vault,
      pubkey: () => this.pubkey,
      now: () => this.now(),
      dialogs: deps.dialogs,
      cache: deps.cache,
      requireProvider: () => this.requireProvider(),
      decryptEvent: (provider, event) => this.syncEngine.decryptEvent(provider, event),
      ensureLatest: (provider, pubkey) => this.syncEngine.ensureLatest(provider, pubkey),
      commit: (provider, pubkey, next) => this.syncEngine.commit(provider, pubkey, next),
      status: () => this.status(),
      sendToast: (toast) => this.sendToast(toast)
    })
    this.webauthnContext = {
      unlocked: () => this.unlocked,
      vault: () => this.vault,
      pubkey: () => this.pubkey,
      now: () => this.now(),
      touch: () => this.touch(),
      requireProvider: () => this.requireProvider(),
      ensureLatest: (provider, pubkey) => this.syncEngine.ensureLatest(provider, pubkey),
      commit: (provider, pubkey, next) => this.syncEngine.commit(provider, pubkey, next)
    }
  }

  status(): PasswordVaultStatus {
    const identity = this.deps.identity.status()
    const provider = this.deps.identity.provider()
    const config = this.deps.config.get().passwords
    const relays = this.syncEngine.relayInfo(config)
    const sync = this.syncEngine.state()
    return {
      configured: identity.configured && provider != null,
      available: provider != null,
      unlocked: this.unlocked,
      entryCount: this.vault ? activeEntries(this.vault).length : 0,
      pending: sync.pending,
      syncing: sync.syncing,
      lastSyncedAt: sync.lastSyncedAt,
      relays: relays.urls,
      relaySource: relays.source,
      mode: identity.mode,
      error: this.error,
      autoLockMinutes: config.autoLockMinutes,
      offerSave: config.offerSave,
      useNip65: config.useNip65,
      vaultRelay: config.vaultRelay,
      neverSave: config.neverSave,
      rotationDays: config.rotationDays
    }
  }

  /** Local-only scan of the unlocked vault for weak, reused, and stale passwords. */
  health(): PasswordHealthReport {
    if (!this.unlocked || !this.vault) {
      return { scannedAt: this.now(), weakCount: 0, reusedCount: 0, oldCount: 0, entries: [] }
    }
    this.touch()
    const rotationDays = this.deps.config.get().passwords.rotationDays
    return scanVaultHealth(this.vault, this.now(), rotationDays)
  }

  context(): PasswordContext {
    const page = this.deps.host.activePage()
    const usable = page != null && page.mode !== 'blank' && page.mode !== 'error'
    const info = usable ? pageOriginFromUrl(page.url) : null
    const status = this.status()
    const originEntries = this.unlocked && this.vault && info && page?.kind !== 'private'
      ? entriesForOrigin(this.vault, info.origin)
      : []
    const matches = originEntries.filter((entry) => !entry.passkey).map(summary)
    const passkeys = originEntries.filter((entry) => entry.passkey).map(summary)
    const form = page ? this.fillController.formFor(page.tabId) : undefined
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
      passkeys,
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
    this.syncEngine.load(pubkey)
    this.error = null

    const cached = this.syncEngine.cachedVault()
    if (cached) {
      try {
        this.vault = await this.syncEngine.decryptEvent(provider, cached.event)
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
      await this.syncEngine.sync(provider, true)
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
    this.syncEngine.resetRelays()
    this.sendStatus()
    this.sendContext()
  }

  dispose(): void {
    this.lockInternal(false)
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    this.fillController.dispose()
  }

  list(): PasswordSummary[] {
    if (!this.unlocked || !this.vault) return []
    this.touch()
    return summarizeVault(this.vault)
  }

  hasWebauthnCredentials(): boolean {
    return hasWebauthnCredentials(this.webauthnContext)
  }

  hasWebauthnCredentialsForPage(page: PasswordPage | null, origin: string): boolean {
    return hasWebauthnCredentialsForPage(this.webauthnContext, page, origin)
  }

  isWebauthnAuthenticatorAvailable(): boolean {
    return isWebauthnAuthenticatorAvailable(this.webauthnContext)
  }

  hasWebauthnCandidates(
    page: PasswordPage | null,
    origin: string,
    options: PasskeyRequestOptions
  ): boolean {
    return hasWebauthnCandidates(this.webauthnContext, page, origin, options)
  }

  entry(id: string): PasswordEntry | null {
    if (!this.unlocked || !this.vault) throw new Error(LOCKED)
    this.touch()
    return findEntry(this.vault, id)
  }

  canHandleWebauthn(
    page: PasswordPage | null,
    origin: string,
    operation: 'create' | 'get',
    input: PasskeyCreationOptions | PasskeyRequestOptions
  ): boolean {
    return canHandleWebauthn(this.webauthnContext, page, origin, operation, input)
  }

  webauthnCreate(
    page: PasswordPage | null,
    origin: string,
    options: PasskeyCreationOptions,
    approve: (site: string, accounts: string[], action: string) => Promise<number | null>
  ): Promise<{ handled: boolean; response?: Record<string, string>; error?: string }> {
    return webauthnCreate(this.webauthnContext, page, origin, options, approve)
  }

  webauthnGet(
    page: PasswordPage | null,
    origin: string,
    options: PasskeyRequestOptions,
    approve: (site: string, accounts: string[], action: string) => Promise<number | null>,
    selectedCredentialId?: string
  ): Promise<{ handled: boolean; response?: Record<string, string>; error?: string }> {
    return webauthnGet(
      this.webauthnContext,
      page,
      origin,
      options,
      approve,
      selectedCredentialId
    )
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
      await this.syncEngine.ensureLatest(provider, this.pubkey)
      const current = this.vault ?? emptyVault()
      const next = applyEntry(current, entry)
      const result = await this.syncEngine.commit(provider, this.pubkey, next)
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
      await this.syncEngine.ensureLatest(provider, this.pubkey)
      const current = this.vault ?? emptyVault()
      const next = applyEntry(current, { ...entry, deleted: true, updatedAt: this.now() })
      return await this.syncEngine.commit(provider, this.pubkey, next)
    } catch (error) {
      this.error = messageOf(error)
      this.sendStatus()
      return { ok: false, error: this.error, status: this.status() }
    }
  }

  /** Background sync when the window regains focus, throttled to once per 30s. */
  async onWindowFocus(): Promise<void> {
    const sync = this.syncEngine.state()
    if (!this.unlocked || sync.syncing) return
    if (sync.lastSyncedAt && this.now() - sync.lastSyncedAt < 30_000) return
    await this.syncNow()
  }

  async syncNow(): Promise<PasswordVaultStatus> {
    if (!this.unlocked) return this.status()
    try {
      await this.syncEngine.sync(this.requireProvider(), true)
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
    return this.fillController.fill(id)
  }

  handleFillResult(payload: unknown): void {
    this.fillController.handleResult(payload)
  }

  handleFormState(webContentsId: number, payload: unknown): void {
    this.fillController.handleFormState(webContentsId, payload)
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
      this.syncEngine.resetRelays()
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

  importOpen(): Promise<PasswordImportPreview> {
    return this.transfer.importOpen()
  }

  importCommit(id: string, mode: 'merge' | 'skip' | 'add'): Promise<PasswordSaveResult> {
    return this.transfer.importCommit(id, mode)
  }

  export(format: 'encrypted' | 'csv'): Promise<PasswordExportResult> {
    return this.transfer.export(format)
  }

  /** Clear any pending chrome save request when the chrome renderer reloads. */
  clearOverlays(): void {
    for (const id of [...this.pendingSaves.keys()]) this.clearSave(id)
    this.sendContext()
  }

  private requireProvider(): ProviderLike {
    const provider = this.deps.identity.provider()
    if (!provider) throw new Error('Set up a Nostr identity to use the password manager.')
    return provider
  }

  relaysFor(pubkey: string): Promise<string[]> {
    return this.syncEngine.relaysFor(pubkey)
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
    this.fillController.clear()
    if (this.lockTimer) clearTimeout(this.lockTimer)
    this.lockTimer = null
    this.deps.onLock?.()
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
