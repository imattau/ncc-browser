import { getPublicKey, nip19 } from 'nostr-tools'

/** The order of secp256k1. */
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const bytes = (value: bigint): Uint8Array =>
  Uint8Array.from(value.toString(16).padStart(64, '0').match(/../g)!, (byte) => parseInt(byte, 16))

const identityOf = (secret: bigint): { pubkey: string; nsec: string } => ({
  pubkey: getPublicKey(bytes(secret)),
  nsec: nip19.nsecEncode(bytes(secret))
})

/** A repeatable throwaway identity. Never a real one. */
export function testIdentity(seed: number): { pubkey: string; nsec: string } {
  return identityOf(BigInt(seed) * 1_000_003n)
}

/** The other secret with the same public key as `testIdentity(seed)`. */
export function negated(identity: { pubkey: string; nsec: string }): { pubkey: string; nsec: string } {
  const decoded = nip19.decode(identity.nsec)
  const secret = BigInt(`0x${Buffer.from(decoded.data as Uint8Array).toString('hex')}`)
  return identityOf(ORDER - secret)
}
