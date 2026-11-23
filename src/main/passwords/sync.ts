import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import {
  PASSWORD_VAULT_CLIENT,
  PASSWORD_VAULT_D,
  PASSWORD_VAULT_KIND,
  PASSWORD_VAULT_TAG,
  PASSWORD_VAULT_VERSION,
  isVaultWithinLimit,
  mergeVaults,
  normalizeVault,
  passwordVaultFilter,
  vaultByteLength,
  type PasswordConfig,
  type PasswordRelaySource,
  type PasswordSaveResult,
  type PasswordVault,
  type PasswordVaultStatus
} from '@shared/passwords'
import { discoverWriteRelays } from '../relay/nip65'
import type { CachedVault, PasswordCache } from './cache'
import type {
  PasswordConfigStoreLike,
  PasswordRelayPoolLike,
  ProviderLike
} from './service'
import {
  MAX_EVENT_CONTENT,
  VAULT_ERROR,
  emptyVault,
  hasLocalChanges,
  trimRelay
} from './vault-ops'

const LOCKED = 'Unlock the password manager first'

/** The state `status()` and the background-focus throttle read. */
export interface PasswordSyncState {
  pending: boolean
  syncing: boolean
  lastSyncedAt: number | null
}

export interface PasswordSyncContext {
  isUnlocked: () => boolean
  vault: () => PasswordVault | null
  setVault: (vault: PasswordVault) => void
  pubkey: () => string | null
  setError: (error: string | null) => void
  now: () => number
  config: PasswordConfigStoreLike
  relays: PasswordRelayPoolLike
  cache: PasswordCache
  status: () => PasswordVaultStatus
  sendStatus: () => void
  sendContext: () => void
}

/**
 * The relay sync engine: relay resolution, fetch/merge/publish, the local cache
 * watermark and the pending/syncing flags. It owns no vault state itself; the
 * service passes the current vault and pubkey through closures.
 */
export class PasswordSync {
  private cached: CachedVault | null = null
  private lastCreatedAt = 0
  private lastSyncedAt: number | null = null
  private pending = false
  private syncing = false
  private resolvedRelays: string[] | null = null
  private relaySource: PasswordRelaySource = 'browser'

  constructor(private readonly ctx: PasswordSyncContext) {}

  state(): PasswordSyncState {
    return {
      pending: this.pending,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt
    }
  }

  cachedVault(): CachedVault | null {
    return this.cached
  }

  /** Adopt the ciphertext cache for a newly unlocked identity. */
  load(pubkey: string): void {
    this.cached = this.ctx.cache.get(pubkey)
    this.lastCreatedAt = this.cached?.event.created_at ?? 0
    this.lastSyncedAt = this.cached?.syncedAt ?? null
    this.pending = this.cached?.pending ?? false
  }

  /** Forget relay resolution after a config or identity change. */
  resetRelays(): void {
    this.resolvedRelays = null
  }

  /** The relays `status()` should show: the resolved set, or the config fallback. */
  relayInfo(config: PasswordConfig): { urls: string[]; source: PasswordRelaySource } {
    if (this.resolvedRelays) return { urls: this.resolvedRelays, source: this.relaySource }
    return this.defaultRelays(config)
  }

  /** The relays sync uses: the same set the vault does, so one setting covers both. */
  relaysFor(pubkey: string): Promise<string[]> {
    return this.resolveRelays(pubkey, false)
  }

  async sync(provider: ProviderLike, refreshRelays: boolean): Promise<void> {
    const pubkey = this.ctx.pubkey()
    if (!this.ctx.isUnlocked() || !pubkey || !this.ctx.vault()) throw new Error(LOCKED)
    this.syncing = true
    this.ctx.sendStatus()
    try {
      const relays = await this.resolveRelays(pubkey, refreshRelays)
      const remote = await this.fetchRemote(provider, pubkey, relays)
      let next = this.ctx.vault()!

      if (remote) {
        const cachedId = this.cached?.event.id
        if (remote.id !== cachedId || this.cached?.pending) {
          const remoteVault = await this.decryptEvent(provider, remote)
          const merged = mergeVaults(this.ctx.vault()!, remoteVault)
          next = merged.vault
          if (hasLocalChanges(this.ctx.vault()!, remoteVault) || this.cached?.pending) {
            const published = await this.publish(provider, pubkey, next, relays)
            this.ctx.setVault(next)
            this.pending = published.pending
            this.lastSyncedAt = this.ctx.now()
            this.ctx.setError(
              published.pending
                ? (published.error ?? 'The vault is saved locally but relay sync failed.')
                : null
            )
            this.ctx.sendStatus()
            return
          }
          this.cached = { event: remote, pending: false, syncedAt: this.ctx.now() }
          this.ctx.cache.set(pubkey, this.cached)
          this.lastCreatedAt = Math.max(this.lastCreatedAt, remote.created_at)
        }
        this.ctx.setVault(next)
        this.lastSyncedAt = this.ctx.now()
        this.pending = false
        this.ctx.setError(null)
        this.ctx.sendStatus()
        return
      }

      const current = this.ctx.vault()!
      if (current.entries.length > 0 || this.cached?.pending) {
        const published = await this.publish(provider, pubkey, current, relays)
        this.pending = published.pending
        this.lastSyncedAt = this.ctx.now()
        this.ctx.setError(
          published.pending
            ? (published.error ?? 'The vault is saved locally but relay sync failed.')
            : null
        )
      } else {
        this.lastSyncedAt = this.ctx.now()
        this.pending = false
        this.ctx.setError(null)
      }
      this.ctx.sendStatus()
    } finally {
      this.syncing = false
      this.ctx.sendStatus()
    }
  }

  async commit(
    provider: ProviderLike,
    pubkey: string,
    next: PasswordVault
  ): Promise<PasswordSaveResult> {
    if (!isVaultWithinLimit(next)) {
      const kb = Math.round(vaultByteLength(next) / 1024)
      throw new Error(
        `The vault would exceed ${kb} KB. Remove entries or shorten notes.`
      )
    }
    const relays = await this.resolveRelays(pubkey, false)
    const published = await this.publish(provider, pubkey, next, relays)
    this.ctx.setVault(next)
    this.pending = published.pending
    this.lastSyncedAt = this.ctx.now()
    this.ctx.setError(
      published.pending ? 'The vault is saved locally but no relay accepted it.' : null
    )
    this.ctx.sendStatus()
    this.ctx.sendContext()
    return {
      ok: true,
      ...(published.pending ? { pending: true } : {}),
      ...(published.pending ? { error: published.error } : {}),
      status: this.ctx.status()
    }
  }

  async ensureLatest(provider: ProviderLike, pubkey: string): Promise<void> {
    const relays = await this.resolveRelays(pubkey, false)
    const remote = await this.fetchRemote(provider, pubkey, relays).catch(() => null)
    if (!remote) return
    const cachedId = this.cached?.event.id
    if (remote.id === cachedId) return
    if (this.cached && remote.created_at < this.cached.event.created_at) return
    const local = this.ctx.vault() ?? emptyVault()
    const remoteVault = await this.decryptEvent(provider, remote)
    const merged = mergeVaults(local, remoteVault)
    this.ctx.setVault(merged.vault)
    this.lastCreatedAt = Math.max(this.lastCreatedAt, remote.created_at)
    if (hasLocalChanges(local, remoteVault)) return
    this.cached = { event: remote, pending: false, syncedAt: this.ctx.now() }
    this.ctx.cache.set(pubkey, this.cached)
  }

  /** Read another identity's prior vault without changing the active sync state. */
  async readVault(provider: ProviderLike, pubkey: string): Promise<{ vault: PasswordVault | null; complete: boolean }> {
    const cached = this.ctx.cache.get(pubkey)
    let local: PasswordVault | null = null
    if (cached) local = await this.decryptEventFor(provider, pubkey, cached.event)

    const relays = await this.resolveRelays(pubkey, true)
    if (relays.length === 0) return { vault: local, complete: false }
    let remote: { event: Event | null; answered: number }
    try {
      remote = await this.fetchRemoteReport(provider, pubkey, relays)
    } catch {
      return { vault: local, complete: false }
    }
    const vault = remote.event
      ? mergeVaults(local ?? emptyVault(), await this.decryptEventFor(provider, pubkey, remote.event)).vault
      : local
    return { vault, complete: remote.answered >= relays.length }
  }

  private async publish(
    provider: ProviderLike,
    pubkey: string,
    vault: PasswordVault,
    relays: string[]
  ): Promise<{ pending: boolean; error?: string; event: Event }> {
    if (relays.length === 0) throw new Error('No vault relay is configured')
    if (!isVaultWithinLimit(vault)) {
      const kb = Math.round(vaultByteLength(vault) / 1024)
      throw new Error(
        `The vault would exceed ${kb} KB. Remove entries or shorten notes.`
      )
    }
    const plaintext = JSON.stringify(vault)
    const content = await provider.nip44Encrypt(pubkey, plaintext)
    const created_at = Math.max(Math.floor(this.ctx.now() / 1000), this.lastCreatedAt + 1)
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
      relays.map((url) => this.ctx.relays.publishWithAuth(url, event, onauth))
    )
    const accepted = results.filter((result) => result.status === 'fulfilled').length
    const pending = accepted < relays.length
    this.lastCreatedAt = event.created_at
    this.cached = {
      event,
      pending,
      syncedAt: this.ctx.now()
    }
    this.ctx.cache.set(pubkey, this.cached)
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
    return (await this.fetchRemoteReport(provider, pubkey, relays)).event
  }

  private async fetchRemoteReport(
    provider: ProviderLike,
    pubkey: string,
    relays: string[]
  ): Promise<{ event: Event | null; answered: number }> {
    if (relays.length === 0) return { event: null, answered: 0 }
    const onauth = (template: EventTemplate): Promise<Event> => this.signAuth(provider, template)
    let events: Event[]
    let answered = relays.length
    if (this.ctx.relays.queryAuthReport) {
      const report = await this.ctx.relays.queryAuthReport(
        relays,
        passwordVaultFilter(pubkey),
        onauth
      )
      // Nothing answered: say so, rather than treating it as a relay with no vault.
      if (report.answered === 0 && report.events.length === 0) {
        throw new Error(`No relay answered (${relays.length} tried)`)
      }
      events = report.events
      answered = report.answered
    } else {
      events = await this.ctx.relays.queryAuth(relays, passwordVaultFilter(pubkey), onauth)
    }
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
    return { event: valid[0] ?? null, answered }
  }

  async decryptEvent(provider: ProviderLike, event: Event): Promise<PasswordVault> {
    const pubkey = this.ctx.pubkey()
    if (!pubkey) throw new Error(VAULT_ERROR)
    return this.decryptEventFor(provider, pubkey, event)
  }

  private async decryptEventFor(provider: ProviderLike, pubkey: string, event: Event): Promise<PasswordVault> {
    const plaintext = await provider.nip44Decrypt(pubkey, event.content)
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

  private async resolveRelays(pubkey: string, force: boolean): Promise<string[]> {
    if (this.resolvedRelays && !force) return this.resolvedRelays
    const config = this.ctx.config.get().passwords
    if (config.vaultRelay) {
      this.resolvedRelays = [trimRelay(config.vaultRelay)]
      this.relaySource = 'dedicated'
      return this.resolvedRelays
    }
    const configured = this.ctx.config.getRelays()
    if (!config.useNip65) {
      this.resolvedRelays = configured
      this.relaySource = 'browser'
      return configured
    }
    let write: string[] = []
    try {
      write = await discoverWriteRelays(this.ctx.relays.query, pubkey, configured)
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
    return { urls: this.ctx.config.getRelays(), source: 'browser' }
  }
}
