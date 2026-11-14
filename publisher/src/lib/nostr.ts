import type { Nip07Signer } from './signer-types'

export type { Nip07Signer, UnsignedEvent } from './signer-types'

declare global {
  interface Window {
    nostr?: Nip07Signer
  }
}

export function detectSigner(): Nip07Signer | null {
  return typeof window !== 'undefined' && window.nostr ? window.nostr : null
}
