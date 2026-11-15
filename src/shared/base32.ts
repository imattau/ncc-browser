/**
 * Lowercase RFC 4648 base32 without padding, used to put service ids that are not
 * hostname-safe into a single DNS-safe label. Reversible, deterministic and stable
 * across restarts, which matters because the label is part of an origin.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32Encode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): string | null {
  const text = input.toLowerCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of text) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}
