import type { Event } from 'nostr-tools'
import type { SignerDecision } from '@shared/types'
import type { ApprovalBroker } from '../approval'
import type { IdentityManager } from './manager'
import type { IdentityProvider } from './provider'
import type { PermissionStore } from './permissions'
import { SignerError, validateTemplate, type EventTemplate } from './crypto'

export interface Caller {
  /** `ncc://<npub>/<service>` for NCC pages, or a normal web origin. */
  origin: string
  /** Human-readable label used in the approval popup. */
  label: string
}

export interface Nip07Deps {
  identity: IdentityManager
  permissions: PermissionStore
  approvals: ApprovalBroker
  getRelays: () => string[]
  /** Development/e2e only: skip the approval popup. */
  autoApprove: boolean
}

interface ApprovalDetail {
  event?: EventTemplate
  note?: string
}

const DENIED = 'The user denied the NIP-07 request'

/**
 * NIP-07 provider. Every sensitive operation needs either a trusted origin or an
 * explicit in-app approval. Requests are serialised so a page cannot stack popups.
 *
 * Signing and encryption are delegated to the active identity provider, which may be
 * a local key or a NIP-46 remote signer.
 */
export class Nip07Service {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: Nip07Deps) {}

  async getPublicKey(caller: Caller): Promise<string> {
    const provider = this.requireProvider()
    const decision = await this.authorize(caller, 'see your public key', {}, 'getPublicKey')
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.getPublicKey()
  }

  async signEvent(caller: Caller, template: unknown): Promise<Event> {
    const normalized = validateTemplate(template)
    const provider = this.requireProvider()
    const decision = await this.authorize(
      caller,
      `sign a kind ${normalized.kind} event`,
      { event: normalized },
      'signEvent'
    )
    if (!decision.allow) throw new SignerError(DENIED)
    return provider.signEvent(normalized)
  }

  async nip04Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const provider = this.requireProvider()
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
    const provider = this.requireProvider()
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
    const provider = this.requireProvider()
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
    const provider = this.requireProvider()
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

  private requireProvider(): IdentityProvider {
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
    method: string
  ): Promise<SignerDecision> {
    if (this.deps.autoApprove) return { allow: true, remember: false }
    if (this.deps.permissions.isTrusted(caller.origin)) {
      this.deps.permissions.touch(caller.origin)
      return { allow: true, remember: false }
    }

    const decision = await this.enqueue(() => this.prompt(caller, action, detail, method))
    if (decision.allow && decision.remember && this.deps.identity.status().mode !== 'none') {
      this.deps.permissions.trust(caller.origin, caller.label)
    }
    return decision
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
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
      rememberable: true
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
