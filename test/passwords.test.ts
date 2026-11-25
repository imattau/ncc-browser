import { describe, expect, it } from 'vitest'
import {
  entriesForOrigin,
  findEntryFor,
  isVaultChangeAllowed,
  isVaultWithinLimit,
  mergeVaults,
  normalizeEntry,
  normalizeImportedOrigin,
  normalizeVault,
  pageOriginFromUrl,
  summarizeVault,
  type PasswordVault
} from '../src/shared/passwords'

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: '0123456789abcdef',
  origin: 'https://example.com',
  title: 'Example',
  username: 'alice',
  password: 'secret',
  notes: '',
  totp: '',
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides
})

describe('pageOriginFromUrl', () => {
  it('normalizes HTTPS and HTTP origins', () => {
    expect(pageOriginFromUrl('https://Example.com:8443/path?q=1')?.origin).toBe(
      'https://example.com:8443'
    )
    expect(pageOriginFromUrl('http://example.com/a')?.origin).toBe('http://example.com')
    expect(pageOriginFromUrl('http://example.com/a')?.secure).toBe(false)
  })

  it('maps ncc:// to the same identity/service label NIP-07 uses', () => {
    const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
    expect(pageOriginFromUrl(`ncc://${npub}/web/page`)?.origin).toBe(`ncc://${npub}/web`)
    expect(pageOriginFromUrl(`ncc://${npub}/_/web/page`)?.origin).toBe(`ncc://${npub}/web`)
    expect(pageOriginFromUrl(`ncc://${npub}/`)?.origin).toBe(`ncc://${npub}/addr`)
  })

  it('rejects unsupported schemes and malformed ncc hosts', () => {
    expect(pageOriginFromUrl('file:///tmp/a')).toBeNull()
    expect(pageOriginFromUrl('javascript:alert(1)')).toBeNull()
    expect(pageOriginFromUrl('ncc://not-a-pubkey/service')).toBeNull()
  })
})

describe('normalizeVault', () => {
  it('drops invalid entries and clamps fields', () => {
    const vault = normalizeVault({
      v: 1,
      updatedAt: 10,
      entries: [
        entry(),
        entry({ id: 'bad' }),
        entry({ origin: 'http://example.com' }),
        entry({ title: 'x'.repeat(500) })
      ]
    })
    expect(vault.entries).toHaveLength(2)
    expect(vault.entries[1].title.length).toBe(200)
  })

  it('rejects entries without a usable origin', () => {
    expect(normalizeEntry(entry({ origin: 'ftp://example.com' }))).toBeNull()
    expect(normalizeEntry(entry({ origin: 'https://example.com' }))).not.toBeNull()
  })
})

describe('mergeVaults', () => {
  const base: PasswordVault = {
    v: 1,
    updatedAt: 1,
    entries: [entry()]
  }

  it('keeps the newer version of an entry', () => {
    const remote: PasswordVault = {
      v: 1,
      updatedAt: 2,
      entries: [entry({ password: 'new', updatedAt: 2000 })]
    }
    const merged = mergeVaults(base, remote)
    expect(merged.changed).toBe(true)
    expect(merged.vault.entries[0].password).toBe('new')
  })

  it('propagates tombstones', () => {
    const remote: PasswordVault = {
      v: 1,
      updatedAt: 2,
      entries: [entry({ deleted: true, updatedAt: 2000 })]
    }
    const merged = mergeVaults(base, remote)
    expect(merged.vault.entries[0].deleted).toBe(true)
    expect(entriesForOrigin(merged.vault, 'https://example.com')).toHaveLength(0)
  })

  it('keeps entries that only exist locally', () => {
    const merged = mergeVaults(base, { v: 1, updatedAt: 0, entries: [] })
    expect(merged.changed).toBe(false)
    expect(merged.vault.entries).toHaveLength(1)
  })

  it('merges favorite metadata independently from password age', () => {
    const local = { ...base.entries[0], updatedAt: 100, favorite: false, favoriteUpdatedAt: 300 }
    const remote = { ...base.entries[0], password: 'newer-password', updatedAt: 200, favorite: true, favoriteUpdatedAt: 250 }
    const merged = mergeVaults({ v: 1, updatedAt: 100, entries: [local] }, { v: 1, updatedAt: 200, entries: [remote] })
    expect(merged.vault.entries[0].password).toBe('newer-password')
    expect(merged.vault.entries[0].favorite).toBe(false)
    expect(merged.vault.entries[0].updatedAt).toBe(200)
  })
})

describe('deleted entries and the size limit', () => {
  const big = (count: number): PasswordVault =>
    normalizeVault({
      v: 1,
      updatedAt: 1000,
      entries: Array.from({ length: count }, (_, index) =>
        entry({ id: index.toString(16).padStart(16, '0'), notes: 'x'.repeat(1000) })
      )
    })

  it('strips the contents of tombstones written by older builds', () => {
    const [gone] = normalizeVault({
      entries: [entry({ deleted: true, notes: 'private', totp: 'ABC', favorite: true })]
    }).entries
    expect(gone).toEqual({
      id: '0123456789abcdef', origin: 'https://example.com', title: '', username: '',
      password: '', notes: '', totp: '', createdAt: 1000, updatedAt: 1000, deleted: true
    })
  })

  it('keeps the username of a deleted identity entry', () => {
    const gone = normalizeEntry(entry({ origin: 'ncc://' + 'a'.repeat(64) + '/identity', deleted: true }))
    expect(gone?.username).toBe('alice')
  })

  it('lets an over-limit vault shrink but not grow', () => {
    const current = big(50)
    const smaller = { ...current, entries: current.entries.slice(1) }
    expect(isVaultWithinLimit(smaller)).toBe(false)
    expect(isVaultChangeAllowed(current, smaller)).toBe(true)
    expect(isVaultChangeAllowed(current, big(51))).toBe(false)
  })
})

describe('entry lookup and summaries', () => {
  const vault: PasswordVault = {
    v: 1,
    updatedAt: 3,
    entries: [
      entry(),
      entry({ id: 'fedcba9876543210', username: 'bob', updatedAt: 3000, totp: 'GEZDGNBV' }),
      entry({ id: '1111222233334444', origin: 'https://other.test', updatedAt: 2000 })
    ]
  }

  it('matches origin exactly and username case-insensitively', () => {
    expect(entriesForOrigin(vault, 'https://example.com')).toHaveLength(2)
    expect(findEntryFor(vault, 'https://example.com', 'ALICE')?.id).toBe('0123456789abcdef')
  })

  it('exposes hasTotp without passwords', () => {
    const summaries = summarizeVault(vault)
    expect(summaries[0].hasTotp).toBe(true)
    expect('password' in summaries[0]).toBe(false)
  })
})

describe('normalizeImportedOrigin', () => {
  it('accepts URLs with and without a scheme', () => {
    expect(normalizeImportedOrigin('https://example.com/login')).toBe('https://example.com')
    expect(normalizeImportedOrigin('example.com')).toBe('https://example.com')
  })

  it('accepts ncc origins and rejects non-web schemes', () => {
    const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
    expect(normalizeImportedOrigin(`ncc://${npub}/web`)).toBe(`ncc://${npub}/web`)
    expect(normalizeImportedOrigin('android://abc')).toBeNull()
  })
})
