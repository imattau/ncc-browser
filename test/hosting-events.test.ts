import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import {
  DEFAULT_HOSTED_TTL_SECONDS,
  isShareService,
  normalizeEndpoint,
  parseRecipient,
  recipientNpub,
  serviceAddress,
  shareDTag,
  shareExpiry,
  shareStatus,
  slugifyService,
  validateHostingDraft,
  validateServiceId,
  type ServiceShare
} from '../src/shared/hosting'
import {
  buildAnchorTemplate,
  buildLocatorPayload,
  buildLocatorTemplate,
  buildTombstoneTemplate,
  sharePayload
} from '../src/shared/hosting-events'

const NOW = 1_800_000_000

function service(overrides: Record<string, unknown> = {}) {
  return {
    id: 'service-1',
    service: 'photos',
    title: 'Photos',
    endpoints: [{ url: 'https://photos.example/', priority: 1000 }],
    ttlSeconds: DEFAULT_HOSTED_TTL_SECONDS,
    visibility: 'private' as const,
    anchor: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

describe('hosting validation', () => {
  it('slugifies titles and keeps reserved share ids out of the namespace', () => {
    expect(slugifyService('My Photos!')).toBe('my-photos')
    expect(slugifyService('Share Photos')).toBe('svc-share-photos')
    expect(validateServiceId('photos').ok).toBe(true)
    expect(validateServiceId('share-photos')).toMatchObject({ ok: false })
    const lowered = validateServiceId('Photos')
    expect(lowered.ok && lowered.value).toBe('photos')
    expect(validateServiceId('a'.repeat(41)).ok).toBe(false)
  })

  it('accepts http and https endpoints and tags onion hosts', () => {
    expect(normalizeEndpoint('http://127.0.0.1:8080')).toMatchObject({
      ok: true,
      value: { url: 'http://127.0.0.1:8080/', priority: 1000, family: 'ipv4' }
    })
    expect(normalizeEndpoint('http://abc.onion:8080')).toMatchObject({
      ok: true,
      value: { family: 'onion' }
    })
    expect(normalizeEndpoint('https://[2001:db8::1]:8443').ok).toBe(true)
  })

  it('rejects credentials, non-http schemes and bad pins', () => {
    expect(normalizeEndpoint('https://user:pass@example.com').ok).toBe(false)
    expect(normalizeEndpoint('file:///etc/passwd').ok).toBe(false)
    expect(normalizeEndpoint('javascript:alert(1)').ok).toBe(false)
    expect(normalizeEndpoint({ url: 'https://example.com', priority: 1, k: 'not base64!' }).ok).toBe(false)
  })

  it('defaults to a private service and refuses a public loopback endpoint', () => {
    const draft = validateHostingDraft({ title: 'Photos', endpoints: ['https://photos.example'] })
    expect(draft).toMatchObject({
      ok: true,
      value: {
        service: 'photos',
        visibility: 'private',
        anchor: false,
        ttlSeconds: DEFAULT_HOSTED_TTL_SECONDS
      }
    })
    expect(
      validateHostingDraft({
        title: 'Local',
        visibility: 'public',
        endpoints: ['http://127.0.0.1:8080']
      })
    ).toMatchObject({ ok: false })
  })

  it('never anchors a private service', () => {
    const draft = validateHostingDraft({
      title: 'Photos',
      visibility: 'private',
      anchor: true,
      endpoints: ['https://photos.example']
    })
    expect(draft.ok && draft.value.anchor).toBe(false)
  })

  it('parses npub and hex recipients', () => {
    const secret = generateSecretKey()
    const hex = getPublicKey(secret)
    expect(parseRecipient(hex)).toBe(hex)
    expect(parseRecipient(recipientNpub(hex))).toBe(hex)
    expect(parseRecipient('npub1notvalid')).toBeNull()
  })

  it('builds a stable, reserved share d tag', () => {
    const recipient = 'a'.repeat(64)
    const tag = shareDTag('photos', recipient)
    expect(tag).toBe(shareDTag('photos', recipient))
    expect(tag).not.toBe(shareDTag('photos', 'b'.repeat(64)))
    expect(tag.startsWith('share-')).toBe(true)
    expect(tag.slice('share-'.length)).toMatch(/^[0-9a-f]{12}$/)
    expect(isShareService(tag)).toBe(true)
    expect(tag.length).toBeLessThanOrEqual(40)
  })

  it('derives share status from expiry and revocation', () => {
    const share: ServiceShare = {
      id: 's',
      serviceId: 'service-1',
      dTag: shareDTag('photos', 'a'.repeat(64)),
      recipient: 'a'.repeat(64),
      recipientNpub: recipientNpub('a'.repeat(64)),
      expiresAt: NOW,
      createdAt: NOW - 100,
      status: 'active'
    }
    expect(shareStatus(share, NOW - 1)).toBe('active')
    expect(shareStatus(share, NOW)).toBe('expired')
    expect(shareStatus({ ...share, status: 'revoked' }, NOW - 1)).toBe('revoked')
    expect(shareExpiry(7, NOW)).toBe(NOW + 7 * 86_400)
  })

  it('builds the display address', () => {
    expect(serviceAddress('npub1test', 'photos')).toBe('ncc://npub1test/photos/')
  })
})

describe('hosting events', () => {
  it('emits the NCC-05 payload shape', () => {
    const payload = buildLocatorPayload(
      [
        { url: 'http://10.0.0.2:8080/', priority: 5, family: 'ipv4' },
        { url: 'https://10.0.0.2:8443/', priority: 1, k: 'SPKI' }
      ],
      600,
      NOW,
      'note'
    )
    expect(payload).toEqual({
      v: 1,
      ttl: 600,
      updated_at: NOW,
      endpoints: [
        { url: 'http://10.0.0.2:8080/', priority: 5, family: 'ipv4' },
        { url: 'https://10.0.0.2:8443/', priority: 1, k: 'SPKI' }
      ],
      notes: 'note'
    })
  })

  it('tags a private locator and sets its expiration', () => {
    const template = buildLocatorTemplate({
      dTag: 'photos',
      ttlSeconds: 600,
      content: 'ciphertext',
      now: NOW,
      privateTag: true
    })
    expect(template.kind).toBe(30058)
    expect(template.content).toBe('ciphertext')
    expect(template.tags).toContainEqual(['d', 'photos'])
    expect(template.tags).toContainEqual(['expiration', String(NOW + 600)])
    expect(template.tags).toContainEqual(['private', 'true'])
  })

  it('uses a fixed expiry for a share', () => {
    const template = buildLocatorTemplate({
      dTag: 'share-1234',
      ttlSeconds: 999_999,
      content: 'ciphertext',
      now: NOW,
      privateTag: true,
      expiresAt: NOW + 60
    })
    expect(template.tags).toContainEqual(['expiration', String(NOW + 60)])
  })

  it('only builds an anchor for a public HTTPS endpoint', () => {
    const endpoint = { url: 'https://photos.example/', priority: 1, k: 'SPKI' }
    const anchor = buildAnchorTemplate({ service: 'photos', endpoint, days: 7, now: NOW })
    expect(anchor?.kind).toBe(30059)
    expect(anchor?.tags).toContainEqual(['d', 'photos'])
    expect(anchor?.tags).toContainEqual(['u', 'https://photos.example/'])
    expect(anchor?.tags).toContainEqual(['k', 'SPKI'])
    expect(anchor?.tags).toContainEqual(['exp', String(NOW + 7 * 86_400)])
    expect(
      buildAnchorTemplate({
        service: 'photos',
        endpoint: { url: 'http://photos.example/', priority: 1 },
        days: 7,
        now: NOW
      })
    ).toBeNull()
    expect(
      buildAnchorTemplate({
        service: 'photos',
        endpoint: { url: 'https://abc.onion/', priority: 1, family: 'onion' },
        days: 7,
        now: NOW
      })
    ).toBeNull()
  })

  it('writes an expired, endpoint-less tombstone', () => {
    const tombstone = buildTombstoneTemplate('share-1234', NOW)
    expect(tombstone.tags).toContainEqual(['d', 'share-1234'])
    expect(tombstone.tags).toContainEqual(['expiration', String(NOW - 1)])
    expect(JSON.parse(tombstone.content).endpoints).toEqual([])
  })

  it('builds a share payload with the share lifetime', () => {
    const payload = sharePayload(service() as never, NOW + 60, NOW)
    expect(payload.ttl).toBe(60)
    expect(payload.endpoints).toHaveLength(1)
  })

  it('encrypts a share to the recipient and not to anyone else', () => {
    const owner = generateSecretKey()
    const recipient = generateSecretKey()
    const stranger = generateSecretKey()
    const json = JSON.stringify(buildLocatorPayload(service().endpoints, 60, NOW))

    const ownerKey = nip44.getConversationKey(owner, getPublicKey(recipient))
    const ciphertext = nip44.encrypt(json, ownerKey)
    expect(ciphertext).not.toContain('photos.example')

    const recipientKey = nip44.getConversationKey(recipient, getPublicKey(owner))
    expect(nip44.decrypt(ciphertext, recipientKey)).toBe(json)

    const strangerKey = nip44.getConversationKey(stranger, getPublicKey(owner))
    expect(() => nip44.decrypt(ciphertext, strangerKey)).toThrow()
  })
})
