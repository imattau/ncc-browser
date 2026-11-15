import { describe, expect, it } from 'vitest'
import { generatePassword } from '../src/main/passwords/generator'

describe('password generator', () => {
  it('respects the requested length and character classes', () => {
    for (let index = 0; index < 40; index += 1) {
      const value = generatePassword({
        length: 24,
        uppercase: true,
        lowercase: true,
        digits: true,
        symbols: true
      })
      expect(value).toHaveLength(24)
      expect(value).toMatch(/[A-Z]/)
      expect(value).toMatch(/[a-z]/)
      expect(value).toMatch(/[0-9]/)
      expect(value).toMatch(/[!@#$%^&*()\-_=+[\]{};:,.?/]/)
    }
  })

  it('honours disabled classes and avoids ambiguous characters', () => {
    for (let index = 0; index < 30; index += 1) {
      const value = generatePassword({
        length: 32,
        uppercase: false,
        lowercase: true,
        digits: false,
        symbols: false,
        avoidAmbiguous: true
      })
      expect(value).toMatch(/^[a-km-z]+$/)
    }
  })

  it('clamps lengths to a safe range', () => {
    expect(generatePassword({ length: 1 })).toHaveLength(12)
    expect(generatePassword({ length: 999 })).toHaveLength(64)
  })
})
