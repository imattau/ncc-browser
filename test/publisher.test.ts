import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import {
  buildAnchorTemplate,
  buildLocatorContent,
  buildLocatorPayload,
  buildLocatorTemplate,
  buildNccAddress,
  endpointUrl,
  newEndpoint,
  parseRelayList,
  validateDraft,
  type PublisherDraft
} from '../publisher/src/lib/locator'
import { signTemplates } from '../publisher/src/lib/publish'

const NOW = 1_800_000_000

function draft(overrides: Partial<PublisherDraft> = {}): PublisherDraft {
  return {
    service: 'web',
    ttl: 600,
    endpoints: [newEndpoint()],
    relays: ['wss://relay.example'],
    encrypt: false,
    publishAnchor: true,
    anchorDays: 14,
    notes: '',
    ...overrides
  }
}

describe('endpointUrl', () => {
  it('builds http and https URLs from host and port', () => {
    expect(endpointUrl(newEndpoint({ host: '127.0.0.1', port: '8080' }))).toBe(
      'http://127.0.0.1:8080'
    )
    expect(
      endpointUrl(newEndpoint({ scheme: 'https', host: '10.0.0.2', port: '8443', path: '/app' }))
    ).toBe('https://10.0.0.2:8443/app')
  })

  it('brackets IPv6 literals and omits an empty port', () => {
    expect(endpointUrl(newEndpoint({ host: '2001:db8::1', port: '8080' }))).toBe(
      'http://[2001:db8::1]:8080'
    )
    expect(endpointUrl(newEndpoint({ scheme: 'https', host: 'example.test', port: '' }))).toBe(
      'https://example.test'
    )
  })
})

describe('locator payload', () => {
  it('emits the NCC-05 shape with priority and optional fields', () => {
    const payload = buildLocatorPayload(
      draft({
        endpoints: [
          newEndpoint({ host: '10.0.0.2', port: '8080', priority: 5 }),
          newEndpoint({ scheme: 'https', host: '10.0.0.2', port: '8443', k: 'SPKI', family: 'ipv4' })
        ],
        notes: 'test'
      }),
      NOW
    )

    expect(payload.v).toBe(1)
    expect(payload.ttl).toBe(600)
    expect(payload.updated_at).toBe(NOW)
    expect(payload.endpoints[0]).toEqual({
      url: 'http://10.0.0.2:8080',
      priority: 5,
      family: 'ipv4'
    })
    expect(payload.endpoints[1]).toMatchObject({ url: 'https://10.0.0.2:8443', k: 'SPKI' })
    expect(payload.notes).toBe('test')
  })

  it('serialises content as JSON', () => {
    const parsed = JSON.parse(buildLocatorContent(draft(), NOW))
    expect(parsed.endpoints[0].url).toBe('http://127.0.0.1:8080')
  })

  it('tags an encrypted locator as private and sets the expiration tag', () => {
    const template = buildLocatorTemplate(draft({ encrypt: true }), 'ciphertext', NOW)
    expect(template.kind).toBe(30058)
    expect(template.content).toBe('ciphertext')
    expect(template.tags).toContainEqual(['d', 'web'])
    expect(template.tags).toContainEqual(['private', 'true'])
    expect(template.tags).toContainEqual(['expiration', String(NOW + 600)])
  })
})

describe('NCC-02 anchor', () => {
  it('uses the primary endpoint, key and expiry', () => {
    const template = buildAnchorTemplate(
      draft({
        endpoints: [newEndpoint({ scheme: 'https', host: '10.0.0.2', port: '8443', k: 'SPKI' })],
        anchorDays: 7
      }),
      NOW
    )
    expect(template?.kind).toBe(30059)
    expect(template?.content).toBe('')
    expect(template?.tags).toContainEqual(['d', 'web'])
    expect(template?.tags).toContainEqual(['u', 'https://10.0.0.2:8443'])
    expect(template?.tags).toContainEqual(['k', 'SPKI'])
    expect(template?.tags).toContainEqual(['exp', String(NOW + 7 * 86_400)])
  })

  it('is omitted when disabled', () => {
    expect(buildAnchorTemplate(draft({ publishAnchor: false }), NOW)).toBeNull()
  })
})

describe('parseRelayList', () => {
  it('keeps valid ws/wss relays and drops everything else', () => {
    const relays = parseRelayList(
      ['wss://relay.example/', 'wss://relay.example', 'https://not-a-relay', 'ws://local:7777'].join(
        '\n'
      )
    )
    expect(relays).toEqual(['wss://relay.example', 'ws://local:7777'])
  })
})

describe('validateDraft', () => {
  it('accepts a normal local publishing draft', () => {
    expect(validateDraft(draft())).toEqual([])
  })

  it('rejects bad service ids, ttl, ports and relays', () => {
    const errors = validateDraft(
      draft({
        service: 'bad/service',
        ttl: 10,
        relays: [],
        endpoints: [newEndpoint({ host: '', port: '99999' })]
      })
    )
    expect(errors.join('\n')).toMatch(/Service id/)
    expect(errors.join('\n')).toMatch(/TTL/)
    expect(errors.join('\n')).toMatch(/relay/)
    expect(errors.join('\n')).toMatch(/host/)
    expect(errors.join('\n')).toMatch(/port/)
  })
})

describe('address and signing', () => {
  it('builds the clean ncc address', () => {
    expect(buildNccAddress('npub1abc', 'web')).toBe('ncc://npub1abc/web')
    expect(buildNccAddress('npub1abc', '')).toBe('ncc://npub1abc/web')
  })

  it('signs publisher templates with NIP-07 and verifies the signature', async () => {
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    const signer = {
      getPublicKey: async () => pk,
      signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, sk)
    }

    const template = buildLocatorTemplate(draft(), buildLocatorContent(draft(), NOW), NOW)
    const events = await signTemplates(signer, [template])
    expect(events).toHaveLength(1)
    expect(verifyEvent(events[0])).toBe(true)
    expect(events[0].kind).toBe(30058)
  })
})
