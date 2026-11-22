import { describe, expect, it } from 'vitest'
import { generatePassword } from '../src/main/passwords/generator'
import { scorePassword } from '../src/shared/password-strength'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

describe('password strength', () => {
  it('scores an empty password as very weak', () => {
    expect(scorePassword('').score).toBe(0)
  })

  it('flags common passwords as very weak regardless of length', () => {
    expect(scorePassword('password1').score).toBe(0)
  })

  it('flags short, repetitive, or sequential passwords as weak', () => {
    expect(scorePassword('a'.repeat(8)).score).toBeLessThanOrEqual(1)
    expect(scorePassword(ALPHABET.slice(0, 8)).score).toBeLessThanOrEqual(1)
    expect(scorePassword('short1!').score).toBeLessThanOrEqual(1)
  })

  it('scores a long mixed-class password as strong or better', () => {
    expect(scorePassword(generatePassword({ length: 24, symbols: true })).score).toBeGreaterThanOrEqual(3)
  })

  it('rates a generator-strength password as very strong', () => {
    expect(scorePassword(generatePassword({ length: 24, symbols: true })).score).toBe(4)
  })

  it('is monotonic: strength never decreases as a generated password gets longer', () => {
    const shorter = scorePassword(generatePassword({ length: 12, symbols: true })).entropyBits
    const longer = scorePassword(generatePassword({ length: 24, symbols: true })).entropyBits
    expect(longer).toBeGreaterThan(shorter)
  })
})
