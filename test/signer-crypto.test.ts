import { describe, expect, it } from 'vitest'
import {
  decryptNip04,
  decryptNip44,
  encryptNip04,
  encryptNip44,
  encryptNip44 as encrypt44,
  npubOf,
  parseSecretKey,
  signTemplate,
  SignerError,
  validateTemplate
} from '../src/main/signer/crypto'
import {
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent
} from 'nostr-tools'

const NOW = 1_800_000_000

describe('parseSecretKey', () => {
  it('accepts nsec and hex', () => {
    const secret = generateSecretKey()
    const hex = [...secret].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect([...parseSecretKey(nip19.nsecEncode(secret))]).toEqual([...secret])
    expect([...parseSecretKey(hex)]).toEqual([...secret])
  })

  it('rejects invalid input', () => {
    expect(() => parseSecretKey('')).toThrow(SignerError)
    expect(() => parseSecretKey('nsec1nope')).toThrow(/nsec/)
    expect(() => parseSecretKey('hello')).toThrow(/nsec1/)
  })
})

describe('npubOf', () => {
  it('derives the npub', () => {
    const secret = generateSecretKey()
    expect(npubOf(secret)).toBe(nip19.npubEncode(getPublicKey(secret)))
  })
})

describe('validateTemplate', () => {
  const base = { kind: 1, content: 'hello', tags: [['t', 'test']] }

  it('fills created_at and normalises missing fields', () => {
    const template = validateTemplate(base, NOW)
    expect(template.created_at).toBe(NOW)
    expect(template.tags).toEqual([['t', 'test']])
    expect(template.content).toBe('hello')
    expect(validateTemplate({ kind: 1 }, NOW).tags).toEqual([])
    expect(validateTemplate({ kind: 1 }, NOW).content).toBe('')
  })

  it('rejects an invalid kind', () => {
    expect(() => validateTemplate({ kind: -1 }, NOW)).toThrow(/kind/)
    expect(() => validateTemplate({ kind: 70000 }, NOW)).toThrow(/kind/)
    expect(() => validateTemplate({ kind: 'one' }, NOW)).toThrow(/kind/)
  })

  it('rejects malformed tags', () => {
    expect(() => validateTemplate({ kind: 1, tags: 'nope' }, NOW)).toThrow(/tags/)
    expect(() => validateTemplate({ kind: 1, tags: [['a', 1]] }, NOW)).toThrow(/strings/)
    expect(() => validateTemplate({ kind: 1, tags: [['a']], content: 1 }, NOW)).toThrow(/content/)
  })

  it('rejects events too far in the future and oversized content', () => {
    expect(() => validateTemplate({ kind: 1, created_at: NOW + 3600 }, NOW)).toThrow(/future/)
    expect(() => validateTemplate({ kind: 1, content: 'a'.repeat(1_000_001) }, NOW)).toThrow(/large/)
  })
})

describe('signTemplate', () => {
  it('produces a verifiable event with the right pubkey', () => {
    const secret = generateSecretKey()
    const event = signTemplate(secret, validateTemplate({ kind: 1, content: 'hi' }, NOW))
    expect(event.pubkey).toBe(getPublicKey(secret))
    expect(event.created_at).toBe(NOW)
    expect(verifyEvent(event)).toBe(true)
  })
})

describe('NIP-04 and NIP-44', () => {
  it('round-trips between two identities', () => {
    const alice = generateSecretKey()
    const bob = generateSecretKey()
    const alicePk = getPublicKey(alice)
    const bobPk = getPublicKey(bob)

    const nip04 = encryptNip04(alice, bobPk, 'hello bob')
    expect(decryptNip04(bob, alicePk, nip04)).toBe('hello bob')

    const nip44 = encryptNip44(alice, bobPk, 'hello again')
    expect(decryptNip44(bob, alicePk, nip44)).toBe('hello again')
  })

  it('rejects a bad peer key and empty payloads', () => {
    const secret = generateSecretKey()
    expect(() => encrypt44(secret, 'not-hex', 'x')).toThrow(/Recipient/)
    expect(() => encrypt44(secret, getPublicKey(generateSecretKey()), '')).toThrow(/Plaintext/)
  })

  it('fails cleanly when the ciphertext is wrong', () => {
    const alice = generateSecretKey()
    const bob = generateSecretKey()
    const bobPk = getPublicKey(bob)
    expect(() => decryptNip44(bob, getPublicKey(alice), encrypt44(bob, bobPk, 'x'))).toThrow(
      SignerError
    )
  })
})
