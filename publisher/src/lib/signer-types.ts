import type { Event } from 'nostr-tools'

export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

/** The subset of NIP-07 the publisher needs. */
export interface Nip07Signer {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent): Promise<Event>
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt?(pubkey: string, ciphertext: string): Promise<string>
  }
}
