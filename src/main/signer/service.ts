import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import type { Event } from 'nostr-tools'
import type { IdentityManager } from './manager'
import type { IdentityProvider } from './provider'
import type { PermissionStore } from './permissions'
import { SignerError, validateTemplate, type EventTemplate } from './crypto'

export interface Caller {
  /** `ncc://<npub>/<service>` for NCC pages, or a normal web origin. */
  origin: string
  /** Human-readable label used in the approval dialog. */
  label: string
}

export interface Nip07Deps {
  identity: IdentityManager
  permissions: PermissionStore
  getWindow: () => BrowserWindow | null
  getRelays: () => string[]
  /** Development/e2e only: skip the approval dialog. */
  autoApprove: boolean
}

const DENIED = 'The user denied the NIP-07 request'

/**
 * NIP-07 provider. Every sensitive operation needs either a trusted origin or an
 * explicit native approval. Dialogs are serialised so a page cannot stack prompts.
 *
 * Signing and encryption are delegated to the active identity provider, which may be
 * a local key or a NIP-46 remote signer.
 */
export class Nip07Service {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: Nip07Deps) {}

  async getPublicKey(caller: Caller): Promise<string> {
    const provider = this.requireProvider()
    const allowed = await this.authorize(caller, 'see your public key', caller.label)
    if (!allowed) throw new SignerError(DENIED)
    return provider.getPublicKey()
  }

  async signEvent(caller: Caller, template: unknown): Promise<Event> {
    const normalized = validateTemplate(template)
    const provider = this.requireProvider()
    const allowed = await this.authorize(
      caller,
      `sign a kind ${normalized.kind} event`,
      describeEvent(normalized)
    )
    if (!allowed) throw new SignerError(DENIED)
    return provider.signEvent(normalized)
  }

  async nip04Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const provider = this.requireProvider()
    if (!(await this.authorize(caller, `encrypt a NIP-04 message for ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return provider.nip04Encrypt(peer, requireText(plaintext, 'Plaintext'))
  }

  async nip04Decrypt(caller: Caller, peer: string, ciphertext: unknown): Promise<string> {
    const provider = this.requireProvider()
    if (!(await this.authorize(caller, `decrypt a NIP-04 message from ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return provider.nip04Decrypt(peer, requireText(ciphertext, 'Ciphertext'))
  }

  async nip44Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const provider = this.requireProvider()
    if (!(await this.authorize(caller, `encrypt a NIP-44 message for ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return provider.nip44Encrypt(peer, requireText(plaintext, 'Plaintext'))
  }

  async nip44Decrypt(caller: Caller, peer: string, ciphertext: unknown): Promise<string> {
    const provider = this.requireProvider()
    if (!(await this.authorize(caller, `decrypt a NIP-44 message from ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
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

  private async authorize(caller: Caller, action: string, detail: string): Promise<boolean> {
    if (this.deps.autoApprove) return true
    if (this.deps.permissions.isTrusted(caller.origin)) {
      this.deps.permissions.touch(caller.origin)
      return true
    }
    return this.enqueue(() => this.prompt(caller, action, detail))
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async prompt(caller: Caller, action: string, detail: string): Promise<boolean> {
    const status = this.deps.identity.status()
    const window = this.deps.getWindow()
    const mode = status.mode === 'nip46' ? 'remote signer' : 'local key'

    const options: MessageBoxOptions = {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'NCC signer',
      message: `Allow this service to ${action}?`,
      detail: [
        detail,
        '',
        `Service: ${caller.label}`,
        `Identity: ${status.npub ?? 'unknown'} (${mode})`,
        '',
        'Only approve if you trust this service. On NCC addresses the npub is the identity; a similar service name is not the same publisher.'
      ].join('\n'),
      checkboxLabel: 'Always allow this service',
      checkboxChecked: false
    }

    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)

    if (result.response !== 0) return false
    if (result.checkboxChecked) {
      this.deps.permissions.trust(caller.origin, caller.label)
    }
    return true
  }
}

function describeEvent(template: EventTemplate): string {
  const content =
    template.content.length > 240 ? `${template.content.slice(0, 240)}…` : template.content
  const tags = template.tags
    .slice(0, 6)
    .map((tag) => tag.slice(0, 3).join(': '))
    .join('\n')
  return [
    `kind: ${template.kind}`,
    `created_at: ${template.created_at}`,
    tags ? `tags:\n${tags}` : 'tags: none',
    content ? `content:\n${content}` : 'content: empty'
  ].join('\n')
}

function shortPeer(peer: string): string {
  return typeof peer === 'string' && peer.length > 12 ? `${peer.slice(0, 8)}…` : String(peer)
}

function requireText(value: unknown, label: string, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SignerError(`${label} must be a non-empty string`)
  }
  if (value.length > max) throw new SignerError(`${label} is too large`)
  return value
}
