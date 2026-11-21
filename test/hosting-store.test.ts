import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostingStore } from '../src/main/hosting/store'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-hosting-')), 'services.json')
}

const NOW = 1_800_000_000

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Photos',
    endpoints: ['https://photos.example/'],
    ...overrides
  }
}

describe('HostingStore', () => {
  it('creates, updates and removes a service', () => {
    let now = NOW
    const store = new HostingStore(tempFile(), () => now)
    const service = store.create(draft())
    expect(service.service).toBe('photos')
    expect(service.visibility).toBe('private')
    expect(service.createdAt).toBe(NOW)

    now += 10
    const updated = store.update(service.id, { ...draft(), title: 'My Photos', ttlSeconds: 3600 })
    expect(updated.title).toBe('My Photos')
    expect(updated.ttlSeconds).toBe(3600)
    expect(updated.createdAt).toBe(NOW)
    expect(updated.updatedAt).toBe(NOW + 10)

    store.remove(service.id)
    expect(store.state().services).toHaveLength(0)
  })

  it('refuses a duplicate service id and a renamed service', () => {
    const store = new HostingStore(tempFile())
    const service = store.create(draft())
    expect(() => store.create(draft({ title: 'Other' }))).not.toThrow()
    expect(() => store.create(draft({ title: 'Photos' }))).toThrow(/already published/)
    expect(() => store.update(service.id, draft({ service: 'other' }))).toThrow(/cannot change/)
  })

  it('records publish state without touching the edit time', () => {
    let now = NOW
    const store = new HostingStore(tempFile(), () => now)
    const service = store.create(draft())
    now += 100
    store.markPublished(service.id, now)
    expect(store.find(service.id)?.lastPublishedAt).toBe(now)
    expect(store.find(service.id)?.updatedAt).toBe(NOW)

    store.markPublishError(service.id, 'relay down')
    expect(store.find(service.id)?.lastPublishError).toBe('relay down')
    store.markPublished(service.id, now)
    expect(store.find(service.id)?.lastPublishError).toBeUndefined()
  })

  it('stores shares and derives expiry on read', () => {
    let now = NOW
    const file = tempFile()
    const store = new HostingStore(file, () => now)
    const service = store.create(draft())
    const share = {
      id: 'share-1',
      serviceId: service.id,
      dTag: 'share-123456789012',
      recipient: 'a'.repeat(64),
      recipientNpub: 'npub1test',
      expiresAt: NOW + 60,
      createdAt: NOW,
      status: 'active' as const
    }
    store.putShare(share)
    expect(store.sharesFor(service.id)).toHaveLength(1)

    now = NOW + 60
    const reloaded = new HostingStore(file, () => now)
    expect(reloaded.state().shares[0]?.status).toBe('expired')
  })

  it('remembers received shares once and forgets them', () => {
    const store = new HostingStore(tempFile(), () => NOW)
    const first = store.recordReceived({
      owner: 'b'.repeat(64),
      ownerNpub: 'npub1owner',
      dTag: 'share-abc',
      expiresAt: NOW + 100,
      title: 'Photos'
    })
    const again = store.recordReceived({
      owner: 'b'.repeat(64),
      ownerNpub: 'npub1owner',
      dTag: 'share-abc',
      expiresAt: NOW + 200
    })
    expect(again.id).toBe(first.id)
    expect(again.firstSeenAt).toBe(first.firstSeenAt)
    expect(again.expiresAt).toBe(NOW + 200)
    expect(again.title).toBeUndefined()
    expect(store.state().received).toHaveLength(1)

    store.forgetReceived(first.id)
    expect(store.state().received).toHaveLength(0)
  })

  it('writes a private, versioned file that reloads', () => {
    const file = tempFile()
    const store = new HostingStore(file, () => NOW)
    const service = store.create(draft())
    const raw = readFileSync(file, 'utf8')
    expect(JSON.parse(raw).version).toBe(1)
    expect(raw).not.toContain('nsec')

    const reloaded = new HostingStore(file, () => NOW)
    expect(reloaded.state().services[0]?.id).toBe(service.id)
  })

  it('starts empty when the file is corrupt', () => {
    const file = tempFile()
    const store = new HostingStore(file, () => NOW)
    store.create(draft())
    writeFileSync(file, '{not json')
    const reloaded = new HostingStore(file, () => NOW)
    expect(reloaded.state().services).toEqual([])
  })
})
