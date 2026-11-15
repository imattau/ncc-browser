/**
 * Identity providers. The rest of the app talks to one of these, so a local key and
 * a NIP-46 remote signer are interchangeable.
 */

import { generateSecretKey, type Event } from 'nostr-tools'
import type { IdentityStatus } from '@shared/types'
import {
  decryptNip04,
  decryptNip44,
  encryptNip04,
  encryptNip44,
  hexPubkeyOf,
  signTemplate,
  SignerError,
  type EventTemplate
} from './crypto'
import type { IdentityStore } from './identity'

export interface IdentityProvider {
  status(): IdentityStatus
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<Event>
  nip04Encrypt(peer: string, plaintext: string): Promise<string>
  nip04Decrypt(peer: string, ciphertext: string): Promise<string>
  nip44Encrypt(peer: string, plaintext: string): Promise<string>
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>
  /** NCC-05 locator payloads: local derives the conversation key, remote asks the signer. */
  decryptLocator(peerPubkey: string, ciphertext: string): Promise<string>
}

export class LocalIdentityProvider implements IdentityProvider {
  constructor(private readonly store: IdentityStore) {}

  status(): IdentityStatus {
    return this.store.status()
  }

  async getPublicKey(): Promise<string> {
    return hexPubkeyOf(this.secret())
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    return signTemplate(this.secret(), template)
  }

  async nip04Encrypt(peer: string, plaintext: string): Promise<string> {
    return encryptNip04(this.secret(), peer, plaintext)
  }

  async nip04Decrypt(peer: string, ciphertext: string): Promise<string> {
    return decryptNip04(this.secret(), peer, ciphertext)
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return encryptNip44(this.secret(), peer, plaintext)
  }

  async nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return decryptNip44(this.secret(), peer, ciphertext)
  }

  async decryptLocator(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.nip44Decrypt(peerPubkey, ciphertext)
  }

  private secret(): Uint8Array {
    const secret = this.store.getSecret()
    if (!secret) throw new SignerError('No Nostr identity is configured')
    return secret
  }
}

/** A generated NIP-07 identity held only for the lifetime of a private/Tor session. */
export class EphemeralIdentityProvider implements IdentityProvider {
  private readonly secret = generateSecretKey()

  clear(): void {
    this.secret.fill(0)
  }

  status(): IdentityStatus {
    return {
      configured: true,
      mode: 'local',
      npub: undefined,
      hexPubkey: hexPubkeyOf(this.secret),
      source: 'session',
      persisted: false,
      encryptionAvailable: false
    }
  }

  async getPublicKey(): Promise<string> {
    return hexPubkeyOf(this.secret)
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    return signTemplate(this.secret, template)
  }

  async nip04Encrypt(peer: string, plaintext: string): Promise<string> {
    return encryptNip04(this.secret, peer, plaintext)
  }

  async nip04Decrypt(peer: string, ciphertext: string): Promise<string> {
    return decryptNip04(this.secret, peer, ciphertext)
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return encryptNip44(this.secret, peer, plaintext)
  }

  async nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return decryptNip44(this.secret, peer, ciphertext)
  }

  async decryptLocator(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.nip44Decrypt(peerPubkey, ciphertext)
  }
}
