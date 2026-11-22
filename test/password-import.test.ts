import { describe, expect, it } from 'vitest'
import {
  exportPasswordCsv,
  parseCsv,
  parsePasswordCsv
} from '../src/main/passwords/import-export'
import type { PasswordEntry } from '../src/shared/passwords'

const entry = (overrides: Partial<PasswordEntry> = {}): PasswordEntry => ({
  id: '0123456789abcdef',
  origin: 'https://example.com',
  title: 'Example',
  username: 'alice',
  password: 'secret',
  notes: '',
  totp: '',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('CSV parser', () => {
  it('handles quotes, commas and newlines', () => {
    expect(parseCsv('a,b\n"x,y","line\nbreak"\n')).toEqual([
      ['a', 'b'],
      ['x,y', 'line\nbreak']
    ])
  })

  it('imports Chrome and Bitwarden shapes', () => {
    const chrome = parsePasswordCsv(
      'name,url,username,password,note\nExample,https://example.com/login,alice,secret,hello\n'
    )
    expect(chrome.format).toBe('chrome')
    expect(chrome.rows[0]).toMatchObject({
      origin: 'https://example.com',
      username: 'alice',
      password: 'secret'
    })

    const bitwarden = parsePasswordCsv(
      'folder,name,login_uri,login_username,login_password,login_totp\nX,Example,https://example.com,alice,secret,GEZDGNBV\n'
    )
    expect(bitwarden.format).toBe('bitwarden')
    expect(bitwarden.rows[0].totp).toBe('GEZDGNBV')
  })

  it('skips rows without a usable origin or password', () => {
    const parsed = parsePasswordCsv(
      'name,url,username,password\nNo URL,,alice,secret\nNo password,https://example.com,alice,\n'
    )
    expect(parsed.rows).toHaveLength(0)
  })
})

describe('CSV export', () => {
  it('quotes cells and neutralises spreadsheet formulas without changing secrets', () => {
    const csv = exportPasswordCsv([
      entry({ title: '=SUM(A1)', notes: 'a,b', password: '=p"quote' })
    ])
    expect(csv).toContain("'=SUM(A1)")
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"=p""quote"')
    expect(csv).not.toContain('\'=p"quote"')
  })
})
