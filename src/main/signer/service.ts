import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { getPublicKey, type Event } from 'nostr-tools'
import type { IdentityStore } from './identity'
import type { PermissionStore } from './permissions'
import {
  decryptNip04,
  decryptNip44,
  encryptNip04,
  encryptNip44,
  signTemplate,
  SignerError,
  validateTemplate,
  type EventTemplate
} from './crypto'

export interface Caller {
  /** `ncc://<npub>` for NCC pages, or a normal web origin. */
  origin: string
  /** Human-readable label used in the approval dialog. */
  label: string
}

export interface Nip07Deps {
  identity: IdentityStore
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
 */
export class Nip07Service {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: Nip07Deps) {}

  async getPublicKey(caller: Caller): Promise<string> {
    const secret = this.requireIdentity()
    const allowed = await this.authorize(caller, 'see your public key', caller.label)
    if (!allowed) throw new SignerError(DENIED)
    return getPublicKey(secret)
  }

  async signEvent(caller: Caller, template: unknown): Promise<Event> {
    const normalized = validateTemplate(template)
    const secret = this.requireIdentity()
    const allowed = await this.authorize(
      caller,
      `sign a kind ${normalized.kind} event`,
      describeEvent(normalized)
    )
    if (!allowed) throw new SignerError(DENIED)
    return signTemplate(secret, normalized)
  }

  async nip04Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const secret = this.requireIdentity()
    if (!(await this.authorize(caller, `encrypt a NIP-04 message for ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return encryptNip04(secret, peer, plaintext)
  }

  async nip04Decrypt(caller: Caller, peer: string, ciphertext: unknown): Promise<string> {
    const secret = this.requireIdentity()
    if (!(await this.authorize(caller, `decrypt a NIP-04 message from ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return decryptNip04(secret, peer, ciphertext)
  }

  async nip44Encrypt(caller: Caller, peer: string, plaintext: unknown): Promise<string> {
    const secret = this.requireIdentity()
    if (!(await this.authorize(caller, `encrypt a NIP-44 message for ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return encryptNip44(secret, peer, plaintext)
  }

  async nip44Decrypt(caller: Caller, peer: string, ciphertext: unknown): Promise<string> {
    const secret = this.requireIdentity()
    if (!(await this.authorize(caller, `decrypt a NIP-44 message from ${shortPeer(peer)}`, caller.label))) {
      throw new SignerError(DENIED)
    }
    return decryptNip44(secret, peer, ciphertext)
  }

  getRelays(): Record<string, { read: boolean; write: boolean }> {
    return Object.fromEntries(
      this.deps.getRelays().map((relay) => [relay, { read: true, write: true }])
    )
  }

  private requireIdentity(): Uint8Array {
    const secret = this.deps.identity.getSecret()
    if (!secret) {
      throw new SignerError(
        'No Nostr identity is configured. Open Settings → Identity to import or generate one.'
      )
    }
    return secret
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
        `Identity: ${status.npub ?? 'unknown'}`,
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
