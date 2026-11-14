import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PermissionStore } from '../src/main/signer/permissions'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-perms-')), 'permissions.json')
}

describe('PermissionStore', () => {
  it('trusts an origin and persists it', () => {
    const file = tempFile()
    const store = new PermissionStore(file)
    expect(store.isTrusted('ncc://npub1a')).toBe(false)

    const record = store.trust('ncc://npub1a', 'ncc://npub1a/web', 100)
    expect(record.trusted).toBe(true)
    expect(store.isTrusted('ncc://npub1a')).toBe(true)

    const reloaded = new PermissionStore(file)
    expect(reloaded.isTrusted('ncc://npub1a')).toBe(true)
    expect(reloaded.list()).toHaveLength(1)
  })

  it('revokes an origin', () => {
    const store = new PermissionStore(tempFile())
    store.trust('https://example.com', 'https://example.com')
    store.revoke('https://example.com')
    expect(store.isTrusted('https://example.com')).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('touches lastUsedAt', () => {
    const store = new PermissionStore(tempFile())
    store.trust('ncc://a', 'a', 100)
    store.touch('ncc://a', 500)
    expect(store.list()[0].lastUsedAt).toBe(500)
    store.touch('ncc://missing', 600)
    expect(store.list()).toHaveLength(1)
  })

  it('caps the number of remembered origins', () => {
    const store = new PermissionStore(tempFile(), 2)
    store.trust('a', 'a', 100)
    store.trust('b', 'b', 200)
    store.trust('c', 'c', 300)
    expect(store.list().map((record) => record.origin)).toEqual(['c', 'b'])
  })

  it('writes a versioned file', () => {
    const file = tempFile()
    new PermissionStore(file).trust('ncc://a', 'a')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.origins['ncc://a'].trusted).toBe(true)
  })
})
