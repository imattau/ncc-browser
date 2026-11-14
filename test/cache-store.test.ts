import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocatorCacheStore } from '../src/main/cache-store'
import type { ResolvedService } from '../src/shared/types'

function record(overrides: Partial<ResolvedService> = {}): ResolvedService {
  return {
    pubkey: 'npub1test',
    hexPubkey: 'a'.repeat(64),
    service: 'web',
    dTag: 'web',
    dTagSource: 'exact',
    endpoints: [
      { url: 'http://1.2.3.4:80/', protocol: 'http', priority: 1, family: 'ipv4', k: null }
    ],
    expiresAt: 2_000,
    updatedAt: 1_000,
    eventId: 'event',
    encrypted: false,
    ...overrides
  }
}

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-cache-'))
  return join(dir, 'locator-cache.json')
}

describe('LocatorCacheStore', () => {
  it('stores and retrieves a record until it expires', () => {
    let now = 1_000
    const store = new LocatorCacheStore(tempFile(), () => now)
    store.set(record())

    expect(store.get('a'.repeat(64), 'web')?.eventId).toBe('event')
    now = 2_000
    expect(store.get('a'.repeat(64), 'web')).toBeNull()
    expect(store.size()).toBe(0)
  })

  it('persists across instances and prunes expired entries on load', () => {
    const file = tempFile()
    const first = new LocatorCacheStore(file, () => 1_000)
    first.set(record())
    first.set(record({ service: 'old', expiresAt: 1_500 }))

    const second = new LocatorCacheStore(file, () => 1_800)
    expect(second.get('a'.repeat(64), 'web')?.eventId).toBe('event')
    expect(second.get('a'.repeat(64), 'old')).toBeNull()
  })

  it('never persists encrypted records', () => {
    const file = tempFile()
    const store = new LocatorCacheStore(file, () => 1_000)
    store.set(record({ encrypted: true }))
    expect(store.size()).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  it('caps the number of entries, dropping those expiring soonest', () => {
    const file = tempFile()
    const store = new LocatorCacheStore(file, () => 1_000, 2)
    store.set(record({ service: 'a', expiresAt: 1_100 }))
    store.set(record({ service: 'b', expiresAt: 1_200 }))
    store.set(record({ service: 'c', expiresAt: 9_000 }))

    expect(store.size()).toBe(2)
    expect(store.get('a'.repeat(64), 'a')).toBeNull()
    expect(store.get('a'.repeat(64), 'c')?.service).toBe('c')
  })

  it('deletes entries and clears the file', () => {
    const file = tempFile()
    const store = new LocatorCacheStore(file, () => 1_000)
    store.set(record())
    store.delete('a'.repeat(64), 'web')
    expect(store.size()).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toEqual({})
  })

  it('ignores a corrupt cache file', () => {
    const file = tempFile()
    writeFileSync(file, 'not json')
    const store = new LocatorCacheStore(file, () => 1_000)
    expect(store.size()).toBe(0)
  })

  it('ignores malformed entries', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: { 'x:y': { hexPubkey: 1 }, 'a:b': record() } })
    )
    const store = new LocatorCacheStore(file, () => 1_000)
    expect(store.size()).toBe(1)
  })
})
