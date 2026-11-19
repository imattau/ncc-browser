import { randomBytes } from 'node:crypto'
import { verifyEvent, type Event, type EventTemplate, type Filter } from 'nostr-tools'
import type { PaymentCard, PaymentCardDraft, PaymentCardSaveRequest, PaymentCardSummary, PasswordPage } from '@shared/types'
import {
  emptyPaymentCardVault, mergePaymentCardVaults, normalizePaymentCardDraft,
  normalizePaymentCardVault, paymentCardSummary, PAYMENT_CARDS_D, PAYMENT_CARDS_TAG,
  PAYMENT_CARDS_VERSION, MAX_PAYMENT_CARDS_BYTES, MAX_PAYMENT_CARD_RECORDS, type PaymentCardVault
} from '@shared/payment-cards'
import type { CachedPaymentCardVault, PaymentCardCache } from './cache'
import type { PasswordIdentityLike, PasswordRelayPoolLike, PasswordHost } from '../passwords/service'

const FILTER: Filter = { kinds: [30078], '#d': [PAYMENT_CARDS_D], limit: 20 }
const MAX_EVENT_CONTENT = 1_000_000

export interface PaymentCardAuth {
  available(): boolean
  authenticate(): Promise<void>
  chooseMethod?(context: PaymentCardAuthContext, systemAvailable: boolean, nostrAvailable: boolean): Promise<{ method: 'system' | 'nostr'; makeDefault: boolean } | null>
}
export interface PaymentCardAuthContext { origin: string; network: string; last4: string }
export interface PaymentCardNostrAuth { available(): boolean; authenticate(context: PaymentCardAuthContext): Promise<void> }
export interface PaymentCardConfigLike {
  enabled(): boolean
  offerSave(): boolean
  saveSecurityCodes(): boolean
  allowNostrAuth(): boolean
  defaultNostrAuth(): boolean
  setDefaultNostrAuth(enabled: boolean): void | Promise<void>
}
export interface PaymentCardServiceDeps {
  identity: PasswordIdentityLike
  relays: PasswordRelayPoolLike
  host: PasswordHost
  cache: PaymentCardCache
  auth: PaymentCardAuth
  nostrAuth: PaymentCardNostrAuth
  config: PaymentCardConfigLike
  relaysFor(pubkey: string): Promise<string[]>
}
interface PendingCardSave { card: PaymentCard; request: PaymentCardSaveRequest; tabId: string; timer: NodeJS.Timeout }

/** Separate NIP-78 collection for card data. The disk cache always contains ciphertext only. */
export class PaymentCardService {
  private pubkey: string | null = null
  private vault: PaymentCardVault | null = null
  private cached: CachedPaymentCardVault | null = null
  private lastCreatedAt = 0
  private identityEpoch = 0
  private migrationNeeded = false
  private pendingSaves = new Map<string, PendingCardSave>()

  constructor(private readonly deps: PaymentCardServiceDeps) {}

  status(): { unlocked: boolean; authAvailable: boolean; nostrAuthAvailable: boolean; allowNostrAuth: boolean; defaultNostrAuth: boolean; enabled: boolean; offerSave: boolean; saveSecurityCodes: boolean; cards: PaymentCardSummary[] } {
    return {
      unlocked: this.vault !== null,
      authAvailable: this.deps.auth.available(),
      nostrAuthAvailable: this.deps.nostrAuth.available(),
      allowNostrAuth: this.deps.config.allowNostrAuth(),
      defaultNostrAuth: this.deps.config.defaultNostrAuth(),
      enabled: this.deps.config.enabled(),
      offerSave: this.deps.config.offerSave(),
      saveSecurityCodes: this.deps.config.saveSecurityCodes(),
      cards: this.vault ? this.vault.cards.filter((card) => !card.deleted).map(paymentCardSummary) : []
    }
  }

  lock(): void {
    this.identityEpoch++
    this.pubkey = null; this.vault = null; this.cached = null
    this.migrationNeeded = false
    for (const pending of this.pendingSaves.values()) clearTimeout(pending.timer)
    this.pendingSaves.clear()
    this.sendStatus()
  }

  async unlock(): Promise<void> {
    const epoch = ++this.identityEpoch
    this.migrationNeeded = false
    const provider = this.deps.identity.provider()
    if (!provider) throw new Error('Set up a Nostr identity to use payment cards.')
    const pubkey = await provider.getPublicKey()
    if (epoch !== this.identityEpoch) throw new Error('The active identity changed while unlocking payment cards.')
    this.pubkey = pubkey
    this.cached = this.deps.cache.get(pubkey)
    this.lastCreatedAt = this.cached?.event.created_at ?? 0
    const vault = this.cached ? await this.decrypt(provider, this.cached.event).catch(() => emptyPaymentCardVault()) : emptyPaymentCardVault()
    if (epoch !== this.identityEpoch) throw new Error('The active identity changed while unlocking payment cards.')
    this.vault = vault
    if (this.migrationNeeded) await this.publish(provider, pubkey, vault, [], epoch)
    await this.sync(epoch).catch((error) => console.warn('[payment-cards] sync failed:', error))
    if (!this.deps.config.saveSecurityCodes()) {
      if (epoch === this.identityEpoch) await this.setSecurityCodeSaving(false).catch((error) => console.warn('[payment-cards] security-code cleanup pending:', error))
    }
    this.sendStatus()
  }

  onIdentityChanged(): void { this.lock() }

  async setSecurityCodeSaving(enabled: boolean): Promise<void> {
    const active = this.deps.host.activePage()
    if (active?.tabId) this.deps.host.sendToContent(active.tabId, 'payments:security-code-setting', enabled)
    if (enabled) return
    for (const [id, pending] of this.pendingSaves) {
      clearTimeout(pending.timer)
      this.pendingSaves.delete(id)
    }
    if (!this.vault || !this.vault.cards.some((card) => card.cvc)) return
    const cards = this.vault.cards.map((card) => {
      const cleaned = { ...card }
      delete cleaned.cvc
      return cleaned
    })
    try {
      await this.commit({ ...this.vault, updatedAt: Date.now(), cards })
    } catch (error) {
      // Keep the codes removed from the live vault even if relay signing fails;
      // the previous ciphertext cache is retained until it can be replaced.
      this.vault = { ...this.vault, updatedAt: Date.now(), cards }
      this.sendStatus()
      throw error
    }
  }

  list(): PaymentCardSummary[] {
    if (!this.vault) return []
    return this.vault.cards.filter((card) => !card.deleted).map(paymentCardSummary)
  }

  async save(input: PaymentCardDraft): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
    try {
      const epoch = this.identityEpoch
      const vault = this.requireVault()
      const existing = input.id ? vault.cards.find((card) => card.id === input.id && !card.deleted) : undefined
      let card = normalizePaymentCardDraft({ ...input, number: input.number || existing?.number || '' }, existing)
      if (!this.deps.config.saveSecurityCodes()) {
        const withoutCvc = { ...card }
        delete withoutCvc.cvc
        card = withoutCvc
      }
      const cards = vault.cards.filter((candidate) => candidate.id !== card.id)
      const tombstones = vault.tombstones.filter((item) => item.id !== card.id)
      if (!existing && vault.cards.length >= 100) throw new Error('The payment card limit is 100')
      if (!existing && cards.length + tombstones.length >= MAX_PAYMENT_CARD_RECORDS) throw new Error('The payment card vault is full. Remove old cards or wait until devices sync.')
      cards.push(card)
      const result = await this.commit({ v: PAYMENT_CARDS_VERSION, updatedAt: Date.now(), cards, tombstones }, epoch)
      return { ok: true, pending: result.pending }
    } catch (error) { return { ok: false, error: messageOf(error) } }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const epoch = this.identityEpoch
      const vault = this.requireVault()
      const card = vault.cards.find((candidate) => candidate.id === id)
      if (!card) throw new Error('That card no longer exists')
      const deletedAt = Date.now()
      await this.commit({ ...vault, updatedAt: deletedAt, cards: vault.cards.filter((candidate) => candidate.id !== id), tombstones: [...vault.tombstones.filter((item) => item.id !== id), { id, deletedAt }] }, epoch)
      return { ok: true }
    } catch (error) { return { ok: false, error: messageOf(error) } }
  }

  handleFieldFocused(webContentsId: number): void {
    const tabId = this.deps.host.tabIdForContents(webContentsId)
    const page = tabId ? this.deps.host.pageForTab(tabId) : null
    if (!tabId) return
    if (page && this.allowed(page)) {
      this.deps.host.sendToContent(tabId, 'payments:security-code-setting', this.deps.config.saveSecurityCodes())
    }
    if (!page || !this.allowed(page) || !this.deps.config.enabled() || !this.deps.auth.available() || !this.vault) {
      this.deps.host.sendToContent(tabId, 'payments:suggestions', [])
      return
    }
    this.deps.host.sendToContent(tabId, 'payments:suggestions', this.list())
  }

  handleCapture(webContentsId: number, payload: unknown): void {
    const tabId = this.deps.host.tabIdForContents(webContentsId)
    const page = tabId ? this.deps.host.pageForTab(tabId) : null
    if (!tabId || !page || !this.allowed(page) || !this.deps.config.offerSave() || !this.vault || !payload || typeof payload !== 'object') return
    const input = payload as Partial<PaymentCardDraft>
    try {
      const cvc = this.deps.config.saveSecurityCodes() && typeof input.cvc === 'string' && /^\d{3,4}$/.test(input.cvc) ? input.cvc : undefined
      const card = normalizePaymentCardDraft({ name: String(input.name ?? ''), number: String(input.number ?? ''), expMonth: String(input.expMonth ?? ''), expYear: String(input.expYear ?? ''), nickname: '', ...(cvc ? { cvc } : {}) })
      const existing = this.vault.cards.find((item) => !item.deleted && item.number === card.number)
      const id = randomBytes(12).toString('hex')
      const request: PaymentCardSaveRequest = {
        id,
        mode: existing ? 'update' : 'create',
        name: card.name,
        last4: card.number.slice(-4),
        network: paymentCardSummary(card).network,
        expMonth: card.expMonth,
        expYear: card.expYear,
        includesSecurityCode: Boolean(card.cvc)
      }
      const timer = setTimeout(() => this.pendingSaves.delete(id), 120_000)
      timer.unref?.()
      this.pendingSaves.set(id, { card: { ...card, id: existing?.id ?? card.id }, request, tabId, timer })
      this.deps.host.sendToChrome('ncc:payment-card-save-request', request)
    } catch { /* Partial or invalid checkout form: do not prompt. */ }
  }

  async respond(id: string, action: 'save' | 'dismiss'): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
    const pending = this.pendingSaves.get(id)
    this.pendingSaves.delete(id)
    if (pending) clearTimeout(pending.timer)
    if (!pending || !this.vault) return { ok: false, error: 'That save request has expired' }
    if (action === 'dismiss') return { ok: true }
    const existing = this.vault.cards.find((card) => card.id === pending.card.id && !card.deleted)
    const draft = { ...pending.card, ...(existing ? { id: existing.id } : {}) }
    const result = await this.save(draft)
    if (!result.ok) {
      const timer = setTimeout(() => this.pendingSaves.delete(id), 120_000)
      timer.unref?.()
      this.pendingSaves.set(id, { ...pending, timer })
    }
    return result
  }

  async fill(webContentsId: number, id: string): Promise<{ ok: boolean; error?: string }> {
    const epoch = this.identityEpoch
    const pubkey = this.pubkey
    const tabId = this.deps.host.tabIdForContents(webContentsId)
    const page = tabId ? this.deps.host.pageForTab(tabId) : null
    if (!tabId || !page || !this.allowed(page)) return { ok: false, error: 'Payment cards are available only on secure normal tabs.' }
    if (!this.deps.config.enabled()) return { ok: false, error: 'Payment card autofill is turned off.' }
    if (!this.vault) return { ok: false, error: 'Unlock the password manager first.' }
    const originalOrigin = originOf(page.url) ?? new URL(page.url).origin
    const card = this.vault.cards.find((candidate) => candidate.id === id && !candidate.deleted)
    if (!card) return { ok: false, error: 'That card no longer exists.' }
    const summary = paymentCardSummary(card)
    const context: PaymentCardAuthContext = { origin: originalOrigin, network: summary.network, last4: summary.last4 }
    let method: 'system' | 'nostr' = 'system'
    if (this.deps.config.allowNostrAuth()) {
      if (this.deps.config.defaultNostrAuth()) method = 'nostr'
      else {
        if (!this.deps.auth.chooseMethod) return { ok: false, error: 'Card authentication choice is unavailable.' }
        try {
          const choice = await this.deps.auth.chooseMethod(context, this.deps.auth.available(), this.deps.nostrAuth.available())
          if (!choice) return { ok: false, error: 'Card authentication was cancelled.' }
          method = choice.method
          if (method === 'nostr' && choice.makeDefault) {
            await this.deps.config.setDefaultNostrAuth(true)
            this.sendStatus()
          }
        } catch (error) { return { ok: false, error: messageOf(error) } }
      }
    }
    try {
      if (method === 'nostr') {
        if (!this.deps.nostrAuth.available()) return { ok: false, error: 'Connect or unlock a Nostr signer to confirm this card fill.' }
        await this.deps.nostrAuth.authenticate(context)
      } else {
        if (!this.deps.auth.available()) return { ok: false, error: 'System authentication is unavailable on this device. Enable Nostr signer confirmation in Payment methods.' }
        await this.deps.auth.authenticate()
      }
    } catch (error) { return { ok: false, error: messageOf(error) } }
    const freshPage = this.deps.host.pageForTab(tabId)
    if (epoch !== this.identityEpoch || pubkey !== this.pubkey || !freshPage || !this.allowed(freshPage) || originOf(freshPage.url) !== originalOrigin || this.deps.host.activePage()?.tabId !== tabId || !this.vault) {
      return { ok: false, error: 'The payment page changed before the card could be filled.' }
    }
    const sent = this.deps.host.sendToContent(tabId, 'payments:fill', {
      name: card.name, number: card.number, expMonth: card.expMonth, expYear: card.expYear,
      ...(this.deps.config.saveSecurityCodes() && card.cvc ? { cvc: card.cvc } : {})
    })
    return sent ? { ok: true } : { ok: false, error: 'The payment form is no longer available.' }
  }

  async syncNow(): Promise<void> { await this.sync() }

  private allowed(page: PasswordPage): boolean {
    return page.kind === 'normal' && page.mode !== 'blank' && page.mode !== 'error' && /^https:\/\//i.test(page.url)
  }

  private requireVault(): PaymentCardVault {
    if (!this.pubkey || !this.vault) throw new Error('Unlock the password manager first')
    return this.vault
  }

  private async sync(expectedEpoch = this.identityEpoch): Promise<void> {
    const provider = this.deps.identity.provider()
    const pubkey = this.pubkey
    if (!provider || !pubkey || !this.vault) return
    const relays = await this.deps.relaysFor(pubkey)
    if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey || !this.vault) return
    const auth = (template: EventTemplate): Promise<Event> => this.signAndVerify(provider, template, pubkey)
    let remote: Event | null = null
    if (relays.length) {
      const events = await this.deps.relays.queryAuth(relays, { ...FILTER, authors: [pubkey] }, auth)
      if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey) return
      remote = events.filter((event) => event.kind === 30078 && event.pubkey === pubkey && event.content.length <= MAX_EVENT_CONTENT && event.tags.some((tag) => tag[0] === 'd' && tag[1] === PAYMENT_CARDS_D) && verifyEvent(event)).sort((a, b) => b.created_at - a.created_at)[0] ?? null
    }
    if (remote) {
      const remoteVault = await this.decrypt(provider, remote)
      if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey || !this.vault) return
      const merged = mergePaymentCardVaults(this.vault, remoteVault)
      const localHasChanges = this.cached?.pending === true || this.vault.cards.some((card) => {
        const match = remoteVault.cards.find((candidate) => candidate.id === card.id)
        return !match || card.updatedAt > match.updatedAt
      }) || this.vault.tombstones.some((item) => !remoteVault.tombstones.some((remoteItem) => remoteItem.id === item.id)) || this.migrationNeeded
      this.vault = merged
      this.cached = { event: remote, pending: false, syncedAt: Date.now() }
      this.deps.cache.set(pubkey, this.cached)
      this.lastCreatedAt = Math.max(this.lastCreatedAt, remote.created_at)
      if (localHasChanges) await this.publish(provider, pubkey, merged, relays, expectedEpoch)
    } else if (this.vault.cards.length || this.vault.tombstones.length || this.cached?.pending) {
      await this.publish(provider, pubkey, this.vault, relays, expectedEpoch)
    }
  }

  private async commit(vault: PaymentCardVault, expectedEpoch = this.identityEpoch): Promise<{ pending: boolean }> {
    const provider = this.deps.identity.provider()
    const pubkey = this.pubkey
    if (!provider || !pubkey) throw new Error('Set up a Nostr identity to use payment cards')
    if (expectedEpoch !== this.identityEpoch) throw new Error('The active identity changed. Unlock payment cards again.')
    const relays = await this.deps.relaysFor(pubkey)
    return this.publish(provider, pubkey, vault, relays, expectedEpoch)
  }

  private async publish(provider: NonNullable<ReturnType<PasswordIdentityLike['provider']>>, pubkey: string, vault: PaymentCardVault, relays: string[], expectedEpoch = this.identityEpoch): Promise<{ pending: boolean }> {
    if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey) throw new Error('The active identity changed. Unlock payment cards again.')
    const plaintext = JSON.stringify(vault)
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PAYMENT_CARDS_BYTES) throw new Error('The card vault is full. Remove cards before adding more.')
    const content = await provider.nip44Encrypt(pubkey, plaintext)
    if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey) throw new Error('The active identity changed. Unlock payment cards again.')
    const event = await provider.signEvent({
      kind: 30078,
      created_at: Math.max(Math.floor(Date.now() / 1000), this.lastCreatedAt + 1),
      tags: [['d', PAYMENT_CARDS_D], ['t', PAYMENT_CARDS_TAG], ['client', 'ncc-browser']],
      content
    })
    if (!verifyEvent(event) || event.pubkey !== pubkey) throw new Error('The signer returned an invalid payment card vault event')
    if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey) throw new Error('The active identity changed. Unlock payment cards again.')
    const results = await Promise.allSettled(relays.map((url) => this.deps.relays.publishWithAuth(url, event, (template) => this.signAndVerify(provider, template, pubkey))))
    if (expectedEpoch !== this.identityEpoch || this.pubkey !== pubkey) throw new Error('The active identity changed. Unlock payment cards again.')
    const accepted = results.filter((result) => result.status === 'fulfilled').length
    const pending = relays.length === 0 || accepted < relays.length
    this.lastCreatedAt = event.created_at
    this.vault = vault
    this.cached = { event, pending, syncedAt: Date.now() }
    this.deps.cache.set(pubkey, this.cached)
    this.migrationNeeded = false
    this.sendStatus()
    return { pending }
  }

  private async decrypt(provider: NonNullable<ReturnType<PasswordIdentityLike['provider']>>, event: Event): Promise<PaymentCardVault> {
    if (!this.pubkey) throw new Error('The payment card vault could not be decrypted')
    const plaintext = await provider.nip44Decrypt(this.pubkey, event.content)
    const parsed = JSON.parse(plaintext) as { v?: unknown }
    if (parsed.v !== PAYMENT_CARDS_VERSION) throw new Error('This payment card vault was created by a newer version')
    this.migrationNeeded ||= Array.isArray((parsed as { cards?: unknown[] }).cards) &&
      (parsed as { cards: Array<{ deleted?: unknown }> }).cards.some((card) => card?.deleted === true)
    return normalizePaymentCardVault(parsed)
  }

  private async signAndVerify(provider: NonNullable<ReturnType<PasswordIdentityLike['provider']>>, template: EventTemplate, expectedPubkey: string): Promise<Event> {
    const event = await provider.signEvent(template)
    if (!verifyEvent(event) || event.pubkey !== expectedPubkey) throw new Error('The signer returned an invalid relay authentication event')
    return event
  }

  private sendStatus(): void { this.deps.host.sendToChrome('ncc:payment-card-status', this.status()) }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function originOf(raw: string): string | null { try { return new URL(raw).origin } catch { return null } }
