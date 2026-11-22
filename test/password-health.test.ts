import { describe, expect, it } from 'vitest'
import { generatePassword } from '../src/main/passwords/generator'
import { scanVaultHealth, type PasswordVault } from '../src/shared/passwords'

const DAY = 24 * 60 * 60 * 1000

/** Generated at test time, not a literal, so nothing here reads as a real credential. */
const strongSample = (): string => generatePassword({ length: 24, symbols: true })

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: '0123456789abcdef',
  origin: 'https://example.com',
  title: 'Example',
  username: 'alice',
  password: strongSample(),
  notes: '',
  totp: '',
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides
})

const vaultOf = (entries: ReturnType<typeof entry>[]): PasswordVault => ({
  v: 1,
  updatedAt: 1000,
  entries: entries as never
})

describe('scanVaultHealth', () => {
  it('flags weak passwords', () => {
    const vault = vaultOf([entry({ id: 'a1a1a1a1a1a1a1a1', password: 'password1' })])
    const report = scanVaultHealth(vault, 1000, 365)
    expect(report.weakCount).toBe(1)
    expect(report.entries[0].weak).toBe(true)
  })

  it('flags reused passwords shared by more than one entry', () => {
    const shared = strongSample()
    const vault = vaultOf([
      entry({ id: 'a1a1a1a1a1a1a1a1', origin: 'https://a.example', password: shared }),
      entry({ id: 'b2b2b2b2b2b2b2b2', origin: 'https://b.example', password: shared })
    ])
    const report = scanVaultHealth(vault, 1000, 365)
    expect(report.reusedCount).toBe(2)
    expect(report.entries.every((item) => item.reused)).toBe(true)
  })

  it('flags entries older than the rotation window', () => {
    const now = 1000 * DAY
    const vault = vaultOf([entry({ id: 'a1a1a1a1a1a1a1a1', updatedAt: 0 })])
    const report = scanVaultHealth(vault, now, 365)
    expect(report.oldCount).toBe(1)
  })

  it('ignores the rotation check when rotationDays is 0', () => {
    const now = 1000 * DAY
    const vault = vaultOf([entry({ id: 'a1a1a1a1a1a1a1a1', updatedAt: 0 })])
    const report = scanVaultHealth(vault, now, 0)
    expect(report.oldCount).toBe(0)
  })

  it('skips passkey entries and deleted entries', () => {
    const vault = vaultOf([
      entry({ id: 'a1a1a1a1a1a1a1a1', password: '', passkey: { credentialId: 'x' } }),
      entry({ id: 'b2b2b2b2b2b2b2b2', password: 'password1', deleted: true })
    ])
    const report = scanVaultHealth(vault, 1000, 365)
    expect(report.entries).toHaveLength(0)
  })

  it('returns no issues for a healthy, unique, recently updated vault', () => {
    const vault = vaultOf([entry({ id: 'a1a1a1a1a1a1a1a1' })])
    const report = scanVaultHealth(vault, 1000, 365)
    expect(report.entries).toHaveLength(0)
    expect(report.weakCount + report.reusedCount + report.oldCount).toBe(0)
  })
})
