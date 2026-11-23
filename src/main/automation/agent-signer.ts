import type { Event } from 'nostr-tools'
import {
  decryptNip04,
  decryptNip44,
  encryptNip04,
  encryptNip44,
  hexPubkeyOf,
  parseSecretKey,
  signTemplate,
  type EventTemplate
} from '../signer/crypto'

/**
 * An agent's own Nostr identity, usable to answer NIP-07 calls from a tab it opened.
 * Thin wrapper over the existing pure signing primitives in `signer/crypto.ts`.
 */
export interface AgentSigner {
  getPublicKey(): string
  signEvent(template: EventTemplate): Event
  nip04Encrypt(peer: string, plaintext: string): string
  nip04Decrypt(peer: string, ciphertext: string): string
  nip44Encrypt(peer: string, plaintext: string): string
  nip44Decrypt(peer: string, ciphertext: string): string
}

export function createAgentSigner(nsec: string): AgentSigner {
  const secret = parseSecretKey(nsec)
  return {
    getPublicKey: () => hexPubkeyOf(secret),
    signEvent: (template) => signTemplate(secret, template),
    nip04Encrypt: (peer, plaintext) => encryptNip04(secret, peer, plaintext),
    nip04Decrypt: (peer, ciphertext) => decryptNip04(secret, peer, ciphertext),
    nip44Encrypt: (peer, plaintext) => encryptNip44(secret, peer, plaintext),
    nip44Decrypt: (peer, ciphertext) => decryptNip44(secret, peer, ciphertext)
  }
}
