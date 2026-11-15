import type { Event } from 'nostr-tools'
import type { SignerDecision, TabKind } from '@shared/types'
import type { ApprovalBroker } from '../approval'
import type { IdentityManager } from './manager'
import { EphemeralIdentityProvider, type IdentityProvider } from './provider'
import type { PermissionStore } from './permissions'
import { SignerError, validateTemplate, type EventTemplate } from './crypto'

export interface Caller {
  /** `ncc://<npub>/<service>` for NCC pages, or a normal web origin. */
  origin: string
  /** Human-readable label used in the approval popup. */
  label: string
  /** Which content session made the request. */
  kind: TabKind
  /** Private or Tor tabs never write persistent permissions. */
  ephemeral: boolean
  /** True for a full Tor tab. */
  torTab: boolean
}

export interface Nip07Deps {
  identity: IdentityManager
  permissions: PermissionStore
  approvals: ApprovalBroker
  getRelays: () => string[]
  /** Development/e2e only: skip the approval popup. */
  autoApprove: boolean
  useEphemeralSigner?: () => boolean
}

interface ApprovalDetail {
  event?: EventTemplate
  note?: string
}

const DENIED = 'The user denied the NIP-07 request'

/** Kind 22242 is NIP-42 relay authentication: signed once per relay, no user content. */
const RELAY_AUTH_KIND = 22242

/** After a refusal, do not re-ask for the same thing for a little while. */
const DENY_COOLDOWN_MS = 30_000

/** Repetitive calls granted for the rest of the session after one approval. */
type SessionGrant = 'getPublicKey' | 'relay-auth'

const ACTION_BY_KIND: Record<number, string> = {
  0: 'update your profile',
  1: 'publish a note',
  3: 'update your follow list',
  4: 'send a direct message',
  5: 'delete an event',
  6: 'repost an event',
  7: 'react to an event',
  1984: 'publish a report',
  9735: 'record a zap receipt',
  10000: 'update your mute list',
  10002: 'publish your relay list',
  30023: 'publish an article',
  22242: 'log in to a relay'
}

/**
 * NIP-07 provider. Every sensitive operation needs either a trusted origin or an
 * explicit in-app approval.
 *
 * Approval prompts are queued per origin, so one page cannot stack popups and a
 * pending prompt for one site does not hold up another. Identical concurrent requests
 * share a single prompt, and the two calls that repeat on every page load — reading the
 * public key and NIP-42 relay authentication — are granted for the session once the
 * user approves them. Anything that signs or decrypts real content still asks.
 *
 * Signing and encryption are delegated to the active identity provider, which may be
 * a local key or a NIP-46 remote signer.
 */
export class Nip07Service {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly inflight = new Map<string, Promise<SignerDecision>>()
  private readonly ephemeralTrust = new Map<TabKind, Set<string>>()
  private readonly sessionGrants = new Map<string, Set<SessionGrant>>()
  private readonly recentlyDenied = new Map<string, number>()
  private readonly ephemeralProviders = new Map<TabKind, EphemeralIdentityProvider>()

  constructor(private readonly deps: Nip07Deps) {}

  /** Drop permissions remembered by a private or Tor session. */
  clearEphemeral(kind: TabKind): void {
    this.ephemeralTrust.delete(kind)
    this.ephemeralProviders.get(kind)?.clear()
    this.ephemeralProviders.delete(kind)
  }

  async getPublicKey(caller: Caller): Promise<string> {
    const provider = this.requireProvider(caller)
    const decision = await this.authorize(
      caller,
      'see your public key',
      {},
      'getPublicKey',
      'getPublicKey'
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.getPublicKey()
  }

  async signEvent(caller: Caller, template: unknown): Promise<Event> {
    const normalized = validateTemplate(template)
    const provider = this.requireProvider(caller)
    const relay = normalized.tags.find((tag) => tag[0] === 'relay')?.[1]
    const decision = await this.authorize(
      caller,
      ACTION_BY_KIND[normalized.kind] ?? `sign a kind ${normalized.kind} event`,
      {
        event: normalized,
        note: normalized.kind === RELAY_AUTH_KIND && relay ? `Relay: ${relay}` : undefined
      },
      'signEvent',
      normalized.kind === RELAY_AUTH_KIND ? 'relay-auth' : undefined
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.signEvent(normalized)
  }

  async nip04Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const provider = this.requireProvider(caller)
    const decision = await this.authorize(
      caller,
      'encrypt a NIP-04 message',
      { note: `To: ${peer}` },
      'nip04Encrypt'
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.nip04Encrypt(peer, requireText(plaintext, 'Plaintext'))
  }

  async nip04Decrypt(caller: Caller, peer: string, ciphertext: unknown): Promise<string> {
    const provider = this.requireProvider(caller)
    const decision = await this.authorize(
      caller,
      'decrypt a NIP-04 message',
      { note: `From: ${peer}` },
      'nip04Decrypt'
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.nip04Decrypt(peer, requireText(ciphertext, 'Ciphertext'))
  }

  async nip44Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const provider = this.requireProvider(caller)
    const decision = await this.authorize(
      caller,
      'encrypt a NIP-44 message',
      { note: `To: ${peer}` },
      'nip44Encrypt'
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.nip44Encrypt(peer, requireText(plaintext, 'Plaintext'))
  }

  async nip44Decrypt(caller: Caller, peer: string, ciphertext: unknown): Promise<string> {
    const provider = this.requireProvider(caller)
    const decision = await this.authorize(
      caller,
      'decrypt a NIP-44 message',
      { note: `From: ${peer}` },
      'nip44Decrypt'
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.nip44Decrypt(peer, requireText(ciphertext, 'Ciphertext'))
  }

  getRelays(): Record<string, { read: boolean; write: boolean }> {
    return Object.fromEntries(
      this.deps.getRelays().map((relay) => [relay, { read: true, write: true }])
    )
  }

  private requireProvider(caller: Caller): IdentityProvider {
    if (caller.ephemeral && this.deps.useEphemeralSigner?.()) {
      let provider = this.ephemeralProviders.get(caller.kind)
      if (!provider) {
        provider = new EphemeralIdentityProvider()
        this.ephemeralProviders.set(caller.kind, provider)
      }
      return provider
    }
    const provider = this.deps.identity.provider()
    if (!provider) {
      throw new SignerError(
        'No Nostr identity is configured. Open Settings → Identity to import, generate, or connect a remote signer.'
      )
    }
    return provider
  }

  private async authorize(
    caller: Caller,
    action: string,
    detail: ApprovalDetail,
    method: string,
    grant?: SessionGrant
  ): Promise<SignerDecision> {
    if (this.deps.autoApprove) return { allow: true, remember: false }

    const trusted = this.trustedBy(caller, grant)
    if (trusted) return this.allow(trusted, caller)

    // One prompt per identical request, however many calls a page makes at once.
    const key = requestKey(caller, method, detail)
    const running = this.inflight.get(key)
    if (running) return running

    const promise = this.enqueue(caller.origin, () =>
      this.decide(caller, action, detail, method, grant, key)
    )
    this.inflight.set(key, promise)
    void promise.then(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    })
    return promise
  }

  private async decide(
    caller: Caller,
    action: string,
    detail: ApprovalDetail,
    method: string,
    grant: SessionGrant | undefined,
    key: string
  ): Promise<SignerDecision> {
    // A decision earlier in this origin's queue may have satisfied the request.
    const trusted = this.trustedBy(caller, grant)
    if (trusted) return this.allow(trusted, caller)

    const refusedAt = this.recentlyDenied.get(key)
    if (refusedAt !== undefined) {
      if (Date.now() - refusedAt < DENY_COOLDOWN_MS) return { allow: false, remember: false }
      this.recentlyDenied.delete(key)
    }

    const decision = await this.prompt(caller, action, detail, method)

    if (!decision.allow) {
      this.recentlyDenied.set(key, Date.now())
      this.pruneDenials()
      return decision
    }

    if (decision.remember && this.providerFor(caller).status().mode !== 'none') {
      if (caller.ephemeral) {
        const trustedOrigins = this.ephemeralTrust.get(caller.kind) ?? new Set<string>()
        trustedOrigins.add(caller.origin)
        this.ephemeralTrust.set(caller.kind, trustedOrigins)
      } else {
        this.deps.permissions.trust(caller.origin, caller.label)
      }
    } else if (grant && !caller.ephemeral) {
      this.grantSession(caller, grant)
    }

    return decision
  }

  private providerFor(caller: Caller): IdentityProvider {
    if (caller.ephemeral && this.deps.useEphemeralSigner?.()) {
      let provider = this.ephemeralProviders.get(caller.kind)
      if (!provider) {
        provider = new EphemeralIdentityProvider()
        this.ephemeralProviders.set(caller.kind, provider)
      }
      return provider
    }
    return this.deps.identity.provider() ?? new EphemeralIdentityProvider()
  }

  /** Keep the refusal table from growing with origins nobody retries. */
  private pruneDenials(): void {
    if (this.recentlyDenied.size <= 200) return
    const now = Date.now()
    for (const [key, at] of this.recentlyDenied) {
      if (now - at >= DENY_COOLDOWN_MS) this.recentlyDenied.delete(key)
    }
  }

  /** `persistent` and `ephemeral` trust cover every method; `session` only one. */
  private trustedBy(
    caller: Caller,
    grant?: SessionGrant
  ): 'persistent' | 'ephemeral' | 'session' | null {
    if (caller.ephemeral) {
      if (this.ephemeralTrust.get(caller.kind)?.has(caller.origin)) return 'ephemeral'
    } else if (this.deps.permissions.isTrusted(caller.origin)) {
      return 'persistent'
    }
    if (grant && this.sessionGrants.get(this.sessionKey(caller))?.has(grant)) return 'session'
    return null
  }

  private allow(
    trust: 'persistent' | 'ephemeral' | 'session',
    caller: Caller
  ): SignerDecision {
    if (trust === 'persistent') this.deps.permissions.touch(caller.origin)
    return { allow: true, remember: false }
  }

  private grantSession(caller: Caller, grant: SessionGrant): void {
    const key = this.sessionKey(caller)
    const grants = this.sessionGrants.get(key) ?? new Set<SessionGrant>()
    grants.add(grant)
    this.sessionGrants.set(key, grants)
  }

  /** Grants are scoped to the current identity as well as the origin. */
  private sessionKey(caller: Caller): string {
    const identity = this.deps.identity.status().npub ?? ''
    return `${identity}|${caller.origin}|${caller.kind}`
  }

  /**
   * Per-origin queue. Ordering is preserved within an origin, so a page cannot stack
   * prompts, but a pending prompt elsewhere does not block this origin.
   */
  private enqueue<T>(origin: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(origin) ?? Promise.resolve()
    const next = previous.then(run, run)
    const settled = next.catch(() => undefined)
    this.queues.set(origin, settled)
    void settled.then(() => {
      if (this.queues.get(origin) === settled) this.queues.delete(origin)
    })
    return next
  }

  private prompt(
    caller: Caller,
    action: string,
    detail: ApprovalDetail,
    method: string
  ): Promise<SignerDecision> {
    const status = this.deps.identity.status()
    return this.deps.approvals.request({
      method,
      action,
      service: caller.label,
      origin: caller.origin,
      identity: status.npub ?? null,
      mode: status.mode,
      event: detail.event,
      note: detail.note,
      rememberable: true,
      ephemeral: caller.ephemeral,
      torTab: caller.torTab,
      rememberLabel: caller.ephemeral ? 'Remember for this session' : 'Always allow'
    })
  }
}

function requireText(value: unknown, label: string, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SignerError(`${label} must be a non-empty string`)
  }
  if (value.length > max) throw new SignerError(`${label} is too large`)
  return value
}

/** Grants are scoped to the current identity as well as the origin. */
function requestKey(caller: Caller, method: string, detail: ApprovalDetail): string {
  return `${caller.origin}|${caller.kind}|${method}|${detail.event?.kind ?? ''}`
}
