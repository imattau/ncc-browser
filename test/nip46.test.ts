import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import {
  parseBunker,
  RemoteIdentityProvider,
  type RemoteSignerLike
} from '../src/main/signer/nip46'
import type { EventTemplate } from '../src/main/signer/crypto'

const REMOTE_SK = generateSecretKey()
const REMOTE_PK = getPublicKey(REMOTE_SK)
const CLIENT_SK = generateSecretKey()

function template(overrides: Partial<EventTemplate> = {}): EventTemplate {
  return { kind: 1, created_at: 1_800_000_000, tags: [], content: 'remote test', ...overrides }
}

function fakeSigner(overrides: Partial<RemoteSignerLike> = {}) {
  const signer: RemoteSignerLike = {
    connect: vi.fn(async () => 'ack'),
    getPublicKey: vi.fn(async () => REMOTE_PK),
    signEvent: vi.fn(async (event: EventTemplate) => finalizeEvent(event, REMOTE_SK)),
    nip04: {
      encrypt: vi.fn(async () => 'nip04-cipher'),
      decrypt: vi.fn(async () => 'nip04-plain')
    },
    nip44: {
      encrypt: vi.fn(async () => 'nip44-cipher'),
      decrypt: vi.fn(async () => 'nip44-plain')
    },
    close: vi.fn(async () => undefined),
    ...overrides
  }
  return signer
}

function provider(signer: RemoteSignerLike) {
  return new RemoteIdentityProvider({
    target: {
      remotePubkey: REMOTE_PK,
      relays: ['wss://relay.example'],
      secret: 'connect-secret'
    },
    clientSecret: CLIENT_SK,
    persisted: true,
    encryptionAvailable: true,
    createSigner: () => signer
  })
}

describe('parseBunker', () => {
  it('parses pubkey, relays and secret', () => {
    const target = parseBunker(
      `bunker://${REMOTE_PK.toUpperCase()}?relay=${encodeURIComponent('wss://relay.example/')}&secret=abc`
    )
    expect(target.remotePubkey).toBe(REMOTE_PK)
    expect(target.relays).toEqual(['wss://relay.example'])
    expect(target.secret).toBe('abc')
  })

  it('accepts repeated relay parameters and ws://', () => {
    const target = parseBunker(
      `bunker://${REMOTE_PK}?relay=${encodeURIComponent('wss://a.example')}&relay=${encodeURIComponent('ws://127.0.0.1:7777')}`
    )
    expect(target.relays).toEqual(['wss://a.example', 'ws://127.0.0.1:7777'])
    expect(target.secret).toBeUndefined()
  })

  it('rejects malformed bunker URLs', () => {
    expect(() => parseBunker('')).toThrow(/bunker/)
    expect(() => parseBunker('https://example.com')).toThrow(/bunker/)
    expect(() => parseBunker(`bunker://${REMOTE_PK}`)).toThrow(/relay/)
    expect(() => parseBunker(`bunker://short?relay=wss%3A%2F%2Fa.example`)).toThrow(/bunker|pubkey/)
    expect(() =>
      parseBunker(`bunker://${REMOTE_PK}?relay=${encodeURIComponent('https://a.example')}`)
    ).toThrow(/bunker|ws/)
  })

  it('keeps ncc:// relay parameters for resolution', () => {
    const npub = nip19.npubEncode(REMOTE_PK)
    const target = parseBunker(
      `bunker://${REMOTE_PK}?relay=${encodeURIComponent(`ncc://${npub}/relay`)}&relay=${encodeURIComponent('wss://a.example')}`
    )
    expect(target.relays).toEqual(['wss://a.example'])
    expect(target.locators).toEqual([`ncc://${npub}/relay`])
  })

  it('accepts a bunker whose only relay is an NCC locator', () => {
    const npub = nip19.npubEncode(REMOTE_PK)
    const target = parseBunker(
      `bunker://${REMOTE_PK}?relay=${encodeURIComponent(`ncc://${npub}/relay`)}&secret=abc`
    )
    expect(target.relays).toEqual([])
    expect(target.locators).toHaveLength(1)
    expect(target.secret).toBe('abc')
  })
})

describe('RemoteIdentityProvider', () => {
  it('reports a NIP-46 identity', () => {
    const signer = fakeSigner()
    const status = provider(signer).status()
    expect(status.mode).toBe('nip46')
    expect(status.connected).toBe(false)
    expect(status.hexPubkey).toBe(REMOTE_PK)
    expect(status.relays).toEqual(['wss://relay.example'])
    expect(status.persisted).toBe(true)
  })

  it('connects once with the bunker secret', async () => {
    const signer = fakeSigner()
    const remote = provider(signer)
    await remote.connect()
    await remote.connect()
    expect(signer.connect).toHaveBeenCalledTimes(1)
    expect(signer.connect).toHaveBeenCalledWith('connect-secret')
    expect(remote.status().connected).toBe(true)
  })

  it('signs through the remote and verifies the result', async () => {
    const signer = fakeSigner()
    const remote = provider(signer)
    const event = await remote.signEvent(template())
    expect(event.pubkey).toBe(REMOTE_PK)
    expect(signer.signEvent).toHaveBeenCalledTimes(1)
  })

  it('rejects an event signed by the wrong key', async () => {
    const otherSk = generateSecretKey()
    const signer = fakeSigner({
      signEvent: vi.fn(async (event: EventTemplate) => finalizeEvent(event, otherSk))
    })
    await expect(provider(signer).signEvent(template())).rejects.toThrow(/mismatched/)
  })

  it('delegates NIP-04, NIP-44 and locator decryption', async () => {
    const signer = fakeSigner()
    const remote = provider(signer)

    expect(await remote.nip04Encrypt(REMOTE_PK, 'x')).toBe('nip04-cipher')
    expect(await remote.nip04Decrypt(REMOTE_PK, 'x')).toBe('nip04-plain')
    expect(await remote.nip44Encrypt(REMOTE_PK, 'x')).toBe('nip44-cipher')
    expect(await remote.decryptLocator(REMOTE_PK, 'x')).toBe('nip44-plain')
    expect(signer.nip44.decrypt).toHaveBeenCalledWith(REMOTE_PK, 'x')
  })

  it('allows retrying after a failed connection', async () => {
    const connect = vi
      .fn<RemoteSignerLike['connect']>()
      .mockRejectedValueOnce(new Error('user rejected'))
      .mockResolvedValueOnce('ack')
    const remote = provider(fakeSigner({ connect }))

    await expect(remote.connect()).rejects.toThrow(/user rejected/)
    expect(remote.status().connected).toBe(false)
    await remote.connect()
    expect(remote.status().connected).toBe(true)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('closes the signer', async () => {
    const signer = fakeSigner()
    await provider(signer).close()
    expect(signer.close).toHaveBeenCalledTimes(1)
  })
})
