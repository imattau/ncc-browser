import { describe, expect, it } from 'vitest'
import { generateTotp, normalizeTotpInput, parseTotp } from '../src/main/passwords/totp'

const SHA1_SECRET = Buffer.from('12345678901234567890', 'ascii')
const SHA256_SECRET = Buffer.from('12345678901234567890123456789012', 'ascii')
const SHA512_SECRET = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii'
)

describe('TOTP', () => {
  it('matches RFC 6238 vectors', () => {
    const vectors = [
      { time: 59, algorithm: 'SHA1' as const, secret: SHA1_SECRET, code: '94287082' },
      { time: 59, algorithm: 'SHA256' as const, secret: SHA256_SECRET, code: '46119246' },
      { time: 59, algorithm: 'SHA512' as const, secret: SHA512_SECRET, code: '90693936' },
      { time: 1_111_111_109, algorithm: 'SHA1' as const, secret: SHA1_SECRET, code: '07081804' },
      { time: 1_111_111_109, algorithm: 'SHA256' as const, secret: SHA256_SECRET, code: '68084774' },
      { time: 1_111_111_109, algorithm: 'SHA512' as const, secret: SHA512_SECRET, code: '25091201' }
    ]
    for (const vector of vectors) {
      expect(
        generateTotp(
          {
            secret: vector.secret,
            algorithm: vector.algorithm,
            digits: 8,
            period: 30
          },
          vector.time * 1000
        ).code
      ).toBe(vector.code)
    }
  })

  it('parses a bare Base32 secret with defaults', () => {
    const config = parseTotp('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
    expect(config.algorithm).toBe('SHA1')
    expect(config.digits).toBe(6)
    expect(config.period).toBe(30)
  })

  it('parses an otpauth URI', () => {
    const config = parseTotp(
      'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&algorithm=SHA256&digits=8&period=60'
    )
    expect(config.algorithm).toBe('SHA256')
    expect(config.digits).toBe(8)
    expect(config.period).toBe(60)
    expect(config.issuer).toBe('Example')
    expect(config.label).toContain('alice')
  })

  it('rejects invalid secrets, and normalizes only valid input', () => {
    expect(() => parseTotp('not base32!')).toThrow()
    expect(normalizeTotpInput('')).toBe('')
    expect(normalizeTotpInput('GEZDGNBV')).toBe('GEZDGNBV')
    expect(() => normalizeTotpInput('!!!!')).toThrow()
  })

  it('reports the remaining seconds in the period', () => {
    const code = generateTotp(
      { secret: SHA1_SECRET, algorithm: 'SHA1', digits: 6, period: 30 },
      60_000
    )
    expect(code.remaining).toBe(30)
  })
})
