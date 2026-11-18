import { describe, expect, it } from 'vitest'
import { normalizeSyncPercent, parseXmrAmount } from '../src/shared/monero-wallet'

describe('Monero amount parsing', () => {
  it('parses XMR decimals exactly into atomic units', () => {
    expect(parseXmrAmount('0.000000000001')).toBe(1n)
    expect(parseXmrAmount('1.234567890123')).toBe(1_234_567_890_123n)
  })

  it('rejects precision beyond atomic units and invalid amounts', () => {
    expect(() => parseXmrAmount('0.0000000000001')).toThrow(/12 decimal places/)
    expect(() => parseXmrAmount('0')).toThrow(/greater than zero/)
    expect(() => parseXmrAmount('-1')).toThrow(/12 decimal places/)
  })
})

describe('Monero sync progress', () => {
  it('converts the 0-1 fraction from monero-ts into a clamped percentage', () => {
    expect(normalizeSyncPercent(0)).toBe(0)
    expect(normalizeSyncPercent(0.4)).toBe(40)
    expect(normalizeSyncPercent(1.2)).toBe(100)
    expect(normalizeSyncPercent(Number.NaN)).toBe(0)
  })
})
