import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event,
  type EventTemplate
} from 'nostr-tools'
import { HostingStore } from '../src/main/hosting/store'
import { shareDTag } from '../src/shared/hosting'
import {
  HostingError,
  HostingService,
  type HostingIdentity,
  type HostingProvider,
  type HostingPublisher,
  type PublishReport
} from '../src/main/hosting/service'

const NOW = 1_800_000_000

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-hosting-service-')), 'services.json')
}

function providerFor(secret: Uint8Array): HostingProvider {
  return {
    getPublicKey: async () => getPublicKey(secret),
    signEvent: async (template: EventTemplate) => finalizeEvent(template, secret),
    nip44Encrypt: async (peer, plaintext) =>
      nip44.encrypt(plaintext, nip44.getConversationKey(secret, peer))
  }
}

class FakePublisher implements HostingPublisher {
  events: Array<{ event: Event; relays: string[] }> = []
  report: PublishReport = { ok: true, accepted: 1, relays: 1, errors: [] }
  handler?: (event: Event) => PublishReport

  async relaysFor(): Promise<string[]> {
    return ['wss://relay.test']
  }

  async publish(event: Event, relays: string[]): Promise<PublishReport> {
    this.events.push({ event, relays })
    return this.handler ? this.handler(event) : this.report
  }

  last(): Event {
    const entry = this.events[this.events.length - 1]
    if (!entry) throw new Error('nothing published')
    return entry.event
  }

  byTag(tag: string, kind?: number): Event | undefined {
    return this.events
      .map((entry) => entry.event)
      .reverse()
      .find(
        (event) =>
          (kind === undefined || event.kind === kind) &&
          event.tags.some((item) => item[0] === 'd' && item[1] === tag)
      )
  }
}

function setup(
  options: { mode?: 'local' | 'nip46'; configured?: boolean; strictAnchors?: boolean } = {}
) {
  const owner = generateSecretKey()
  const ownerHex = getPublicKey(owner)
  const publisher = new FakePublisher()
  let now = NOW
  const store = new HostingStore(tempFile(), () => now)
  const identity: HostingIdentity = {
    provider: () => (options.configured === false ? null : providerFor(owner)),
    status: () => ({
      configured: options.configured !== false,
      mode: options.mode ?? 'local',
      hexPubkey: ownerHex
    })
  }
  const changes: number[] = []
  const hosting = new HostingService({
    store,
    identity,
    publisher,
    ...(options.strictAnchors ? { anchorRequired: () => true } : {}),
    now: () => now,
    onChange: (state) => changes.push(state.services.length)
  })
  return {
    owner,
    ownerHex,
    publisher,
    hosting,
    store,
    changes,
    advance: (seconds: number) => {
      now += seconds
    }
  }
}

describe('HostingService publishing', () => {
  it('publishes a private locator encrypted to the owner', async () => {
    const { owner, ownerHex, publisher, hosting } = setup()
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    const result = await hosting.publish(service.id)

    expect(result.ok).toBe(true)
    const event = publisher.last()
    expect(event.kind).toBe(30058)
    expect(event.pubkey).toBe(ownerHex)
    expect(event.tags).toContainEqual(['d', 'photos'])
    expect(event.tags).toContainEqual(['private', 'true'])
    expect(event.content.startsWith('{')).toBe(false)

    const key = nip44.getConversationKey(owner, ownerHex)
    const payload = JSON.parse(nip44.decrypt(event.content, key))
    expect(payload.v).toBe(1)
    expect(payload.endpoints[0].url).toBe('https://photos.example/')
    expect(hosting.state().services[0]?.lastPublishedAt).toBe(NOW)
  })

  it('publishes a public locator in plaintext and can add an anchor', async () => {
    const { publisher, hosting } = setup()
    const service = hosting.create({
      title: 'Blog',
      visibility: 'public',
      anchor: true,
      endpoints: ['https://blog.example']
    })
    await hosting.publish(service.id)
    const locator = publisher.events
      .map((entry) => entry.event)
      .find((event) => event.kind === 30058 && event.tags.some(([name, value]) => name === 'd' && value === 'blog'))
    expect(locator?.content.startsWith('{')).toBe(true)
    expect(locator?.tags).not.toContainEqual(['private', 'true'])
    expect(publisher.events.some((entry) => entry.event.kind === 30059)).toBe(true)
  })

  it('does not publish from a missing identity', async () => {
    const { hosting } = setup({ configured: false })
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    await expect(hosting.publish(service.id)).rejects.toMatchObject({ code: 'identity-required' })
  })

  it('records a relay failure on the service', async () => {
    const { publisher, hosting, store } = setup()
    publisher.report = {
      ok: false,
      accepted: 0,
      relays: 1,
      errors: [{ relay: 'wss://relay.test', error: 'blocked' }]
    }
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    await expect(hosting.publish(service.id)).rejects.toBeInstanceOf(HostingError)
    expect(store.find(service.id)?.lastPublishError).toContain('blocked')
  })

  it('records the owner and refuses a different identity', async () => {
    const owner = generateSecretKey()
    const other = generateSecretKey()
    let active = owner
    const publisher = new FakePublisher()
    const store = new HostingStore(tempFile(), () => NOW)
    const hosting = new HostingService({
      store,
      identity: {
        provider: () => providerFor(active),
        status: () => ({
          configured: true,
          mode: 'local',
          hexPubkey: getPublicKey(active)
        })
      },
      publisher,
      now: () => NOW
    })
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    await hosting.publish(service.id)
    expect(store.find(service.id)?.owner).toBe(getPublicKey(owner))

    active = other
    await expect(hosting.publish(service.id)).rejects.toMatchObject({ code: 'wrong-identity' })
  })

  it('fails a publish when strict anchoring rejects the anchor', async () => {
    const { hosting, publisher, store } = setup({ strictAnchors: true })
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    publisher.handler = (event) =>
      event.kind === 30059
        ? { ok: false, accepted: 0, relays: 1, errors: [{ relay: 'wss://relay.test', error: 'blocked' }] }
        : { ok: true, accepted: 1, relays: 1, errors: [] }
    await expect(hosting.publish(service.id)).rejects.toMatchObject({ code: 'publish-failed' })
    expect(store.find(service.id)?.lastPublishError).toContain('NCC-02')
    expect(publisher.byTag('photos', 30058)).toBeUndefined()
  })

  it('keeps a publish when the optional anchor is rejected', async () => {
    const { hosting, publisher } = setup()
    const service = hosting.create({
      title: 'Photos',
      anchor: true,
      endpoints: ['https://photos.example']
    })
    publisher.handler = (event) =>
      event.kind === 30059
        ? { ok: false, accepted: 0, relays: 1, errors: [{ relay: 'wss://relay.test', error: 'blocked' }] }
        : { ok: true, accepted: 1, relays: 1, errors: [] }
    const result = await hosting.publish(service.id)
    expect(result.ok).toBe(true)
    expect(result.errors).toContainEqual({ relay: 'anchor', error: expect.stringContaining('blocked') })
  })

  it('bumps created_at so a replacement wins the resolver tie-break', async () => {
    const { publisher, hosting } = setup()
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    await hosting.publish(service.id)
    const first = publisher.byTag('photos')?.created_at ?? 0
    await hosting.publish(service.id)
    const second = publisher.byTag('photos')?.created_at ?? 0
    expect(second).toBeGreaterThan(first)

    const share = await hosting.share(service.id, getPublicKey(generateSecretKey()), 7)
    const shareEvent = publisher.byTag(share.share.dTag, 30058)
    await hosting.revokeShare(share.share.id)
    const tombstone = publisher.byTag(share.share.dTag, 30058)
    expect(tombstone?.created_at ?? 0).toBeGreaterThan(shareEvent?.created_at ?? 0)
  })
})

describe('HostingService shares', () => {
  it('publishes a share encrypted to the recipient under a reserved d tag', async () => {
    const { owner, ownerHex, publisher, hosting } = setup()
    const recipient = generateSecretKey()
    const recipientHex = getPublicKey(recipient)
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })

    const result = await hosting.share(service.id, recipientHex, 7)
    expect(result.address.startsWith('ncc://npub1')).toBe(true)
    expect(result.address).toContain('/share-')
    expect(result.share.recipient).toBe(recipientHex)
    expect(result.share.dTag.startsWith('share-')).toBe(true)

    const event = publisher.byTag(result.share.dTag, 30058)
    expect(event?.tags).toContainEqual(['d', result.share.dTag])
    expect(event?.tags).toContainEqual(['private', 'true'])
    expect(event?.tags.some(([name]) => name === 'expiration')).toBe(true)

    const anchor = publisher.byTag(result.share.dTag, 30059)
    expect(anchor?.tags).toContainEqual(['d', result.share.dTag])
    expect(anchor?.tags.some(([name]) => name === 'u')).toBe(false)

    const recipientKey = nip44.getConversationKey(recipient, ownerHex)
    expect(event).toBeDefined()
    const payload = JSON.parse(nip44.decrypt(event!.content, recipientKey))
    expect(payload.endpoints[0].url).toBe('https://photos.example/')

    const stranger = generateSecretKey()
    const strangerKey = nip44.getConversationKey(stranger, ownerHex)
    expect(() => nip44.decrypt(event!.content, strangerKey)).toThrow()

    const key = nip44.getConversationKey(owner, ownerHex)
    expect(() => nip44.decrypt(event!.content, key)).toThrow()
  })

  it('fails a share in strict mode when its anchor is rejected', async () => {
    const { hosting, publisher } = setup({ strictAnchors: true })
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    publisher.handler = (event) =>
      event.kind === 30059
        ? { ok: false, accepted: 0, relays: 1, errors: [{ relay: 'wss://relay.test', error: 'blocked' }] }
        : { ok: true, accepted: 1, relays: 1, errors: [] }
    await expect(hosting.share(service.id, getPublicKey(generateSecretKey()), 7)).rejects.toMatchObject({
      code: 'publish-failed'
    })
    expect(hosting.state().shares).toHaveLength(0)
  })

  it('refuses a public service and a loopback share', async () => {
    const { hosting } = setup()
    const publicService = hosting.create({
      title: 'Blog',
      visibility: 'public',
      endpoints: ['https://blog.example']
    })
    await expect(hosting.share(publicService.id, 'a'.repeat(64), 7)).rejects.toMatchObject({
      code: 'public-service'
    })

    const localService = hosting.create({
      title: 'Local',
      endpoints: ['http://127.0.0.1:8080']
    })
    await expect(hosting.share(localService.id, 'a'.repeat(64), 7)).rejects.toMatchObject({
      code: 'loopback-share'
    })
  })

  it('shares with more than one recipient in one batch', async () => {
    const { ownerHex, publisher, hosting } = setup()
    const recipientA = generateSecretKey()
    const recipientB = generateSecretKey()
    const pubA = getPublicKey(recipientA)
    const pubB = getPublicKey(recipientB)
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })

    const result = await hosting.shareMany(service.id, [pubA, pubB, pubA], 7, 'friends')
    expect(result.shares).toHaveLength(2)
    expect(result.failures).toHaveLength(0)
    expect(hosting.state().shares).toHaveLength(2)

    const eventA = publisher.byTag(shareDTag('photos', pubA), 30058)
    const eventB = publisher.byTag(shareDTag('photos', pubB), 30058)
    expect(eventA).toBeDefined()
    expect(eventB).toBeDefined()
    expect(
      JSON.parse(nip44.decrypt(eventA!.content, nip44.getConversationKey(recipientA, ownerHex))).endpoints[0].url
    ).toBe('https://photos.example/')
    expect(
      JSON.parse(nip44.decrypt(eventB!.content, nip44.getConversationKey(recipientB, ownerHex))).endpoints[0].url
    ).toBe('https://photos.example/')
  })

  it('continues a batch when one recipient cannot be shared', async () => {
    const { hosting, publisher } = setup()
    const recipientA = generateSecretKey()
    const recipientB = generateSecretKey()
    const pubA = getPublicKey(recipientA)
    const pubB = getPublicKey(recipientB)
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    publisher.handler = (event) =>
      event.tags.some(([name, value]) => name === 'd' && value === shareDTag('photos', pubB))
        ? { ok: false, accepted: 0, relays: 1, errors: [{ relay: 'wss://relay.test', error: 'blocked' }] }
        : { ok: true, accepted: 1, relays: 1, errors: [] }

    const result = await hosting.shareMany(service.id, [pubA, pubB], 7)
    expect(result.shares).toHaveLength(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.recipient).toBe(pubB)
    expect(hosting.state().shares).toHaveLength(1)
  })

  it('replaces a share for the same recipient instead of duplicating it', async () => {
    const { hosting } = setup()
    const recipientHex = getPublicKey(generateSecretKey())
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    const first = await hosting.share(service.id, recipientHex, 7)
    const second = await hosting.share(service.id, recipientHex, 30)
    expect(second.share.id).toBe(first.share.id)
    expect(second.share.expiresAt).toBeGreaterThan(first.share.expiresAt)
    expect(hosting.state().shares).toHaveLength(1)
  })

  it('re-sharing after a revoke beats the tombstone', async () => {
    const { publisher, hosting } = setup()
    const recipient = getPublicKey(generateSecretKey())
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    const first = await hosting.share(service.id, recipient, 7)
    await hosting.revokeShare(first.share.id)
    const tombstone = publisher.events
      .map((entry) => entry.event)
      .filter((event) => event.tags.some(([name, value]) => name === 'd' && value === first.share.dTag))
      .at(-1)
    const second = await hosting.share(service.id, recipient, 7)
    expect(second.share.id).toBe(first.share.id)
    const latest = publisher.events
      .map((entry) => entry.event)
      .filter((event) => event.tags.some(([name, value]) => name === 'd' && value === first.share.dTag))
      .at(-1)
    expect(latest?.created_at ?? 0).toBeGreaterThan(tombstone?.created_at ?? 0)
    expect(hosting.state().shares[0]?.status).toBe('active')
  })

  it('revokes a share with an expired tombstone', async () => {
    const { publisher, hosting } = setup()
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    const share = await hosting.share(service.id, getPublicKey(generateSecretKey()), 7)

    const result = await hosting.revokeShare(share.share.id)
    expect(result.share.status).toBe('revoked')
    const tombstone = publisher.last()
    expect(tombstone.tags).toContainEqual(['d', share.share.dTag])
    const expiration = Number(tombstone.tags.find(([name]) => name === 'expiration')?.[1])
    expect(expiration).toBeLessThan(NOW)
    expect(hosting.state().shares[0]?.status).toBe('revoked')
  })

  it('re-publishes active shares when the service endpoints change', async () => {
    const { publisher, hosting } = setup()
    const service = hosting.create({ title: 'Photos', endpoints: ['https://photos.example'] })
    await hosting.share(service.id, getPublicKey(generateSecretKey()), 7)
    const shareEvents = publisher.events.filter(
      (entry) =>
        entry.event.kind === 30058 &&
        entry.event.tags.some(([name, value]) => name === 'd' && value?.startsWith('share-'))
    )
    expect(shareEvents).toHaveLength(1)

    hosting.update(service.id, {
      title: 'Photos',
      endpoints: ['https://new.photos.example'],
      visibility: 'private'
    })
    const before = publisher.events.length
    await hosting.publish(service.id)
    expect(publisher.events.length).toBeGreaterThan(before)
    const latestShare = publisher.events
      .map((entry) => entry.event)
      .reverse()
      .find((event) => event.tags.some(([name, value]) => name === 'd' && value?.startsWith('share-')))
    expect(latestShare).toBeTruthy()
  })
})

describe('HostingService renewal and received shares', () => {
  it('renews a local locator after half its lifetime', async () => {
    const { publisher, hosting, advance } = setup()
    const service = hosting.create({
      title: 'Photos',
      ttlSeconds: 3600,
      endpoints: ['https://photos.example']
    })
    await hosting.publish(service.id)
    const firstCount = publisher.events.length
    expect(await hosting.renewDue()).toHaveLength(0)

    advance(1800)
    const renewed = await hosting.renewDue()
    expect(renewed).toHaveLength(1)
    expect(publisher.events.length).toBeGreaterThan(firstCount)
  })

  it('does not auto-renew with a remote signer', async () => {
    const { hosting, advance } = setup({ mode: 'nip46' })
    const service = hosting.create({
      title: 'Photos',
      ttlSeconds: 3600,
      endpoints: ['https://photos.example']
    })
    await hosting.publish(service.id)
    advance(1800)
    expect(await hosting.renewDue()).toHaveLength(0)
  })

  it('records a received share once and never its own service', () => {
    const { hosting, ownerHex } = setup()
    expect(
      hosting.recordReceived({
        owner: ownerHex,
        dTag: 'share-1',
        expiresAt: NOW + 100,
        encrypted: true
      })
    ).toBeNull()

    const received = hosting.recordReceived({
      owner: 'b'.repeat(64),
      dTag: 'share-2',
      expiresAt: NOW + 100,
      title: 'Photos',
      encrypted: true
    })
    expect(received?.title).toBe('Photos')
    expect(hosting.state().received).toHaveLength(1)
    hosting.forgetReceived(received?.id ?? '')
    expect(hosting.state().received).toHaveLength(0)
  })

  it('adds and removes an onion endpoint without dropping others', () => {
    const { hosting } = setup()
    const service = hosting.create({
      title: 'Photos',
      endpoints: ['http://127.0.0.1:8080', 'https://photos.example']
    })
    const withOnion = hosting.attachOnion(service.id, 'http://abcdefghijklmnop.onion/')
    expect(withOnion.endpoints.map((endpoint) => endpoint.url)).toEqual([
      'http://127.0.0.1:8080/',
      'https://photos.example/',
      'http://abcdefghijklmnop.onion/'
    ])
    expect(withOnion.endpoints[2].priority).toBeGreaterThan(withOnion.endpoints[1].priority)

    // Re-attaching replaces the old onion rather than adding a second one.
    const replaced = hosting.attachOnion(service.id, 'http://zyxwvutsrqponmlk.onion/')
    expect(replaced.endpoints.filter((endpoint) => endpoint.url.endsWith('.onion/'))).toHaveLength(1)

    const detached = hosting.detachOnion(service.id)
    expect(detached.endpoints.map((endpoint) => endpoint.url)).toEqual([
      'http://127.0.0.1:8080/',
      'https://photos.example/'
    ])
  })

  it('rewrites endpoints when a local address changes', () => {
    const { hosting } = setup()
    const service = hosting.create({
      title: 'Photos',
      endpoints: ['http://192.168.1.20:8080/app?x=1', 'https://blog.example']
    })
    expect(hosting.replaceAddress('192.168.1.20', '192.168.1.99')).toEqual({ updated: 1 })
    expect(hosting.find(service.id)?.endpoints[0].url).toBe('http://192.168.1.99:8080/app?x=1')
    expect(hosting.find(service.id)?.endpoints[1].url).toBe('https://blog.example/')
    expect(hosting.replaceAddress('192.168.1.99', '192.168.1.99')).toEqual({ updated: 0 })
  })

  it('exposes onion status through state() and can find a service', () => {
    const { hosting } = setup()
    const service = hosting.create({ title: 'Photos', endpoints: ['http://127.0.0.1:8080'] })
    expect(hosting.find(service.id)?.title).toBe('Photos')
    expect(hosting.find('missing')).toBeNull()
  })

  it('ignores a plaintext locator', () => {
    const { hosting } = setup()
    expect(
      hosting.recordReceived({
        owner: 'b'.repeat(64),
        dTag: 'share-3',
        expiresAt: NOW + 100,
        encrypted: false
      })
    ).toBeNull()
  })
})
