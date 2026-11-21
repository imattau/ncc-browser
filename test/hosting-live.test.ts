/**
 * Opt-in end-to-end check against a real relay:
 *
 *   nak serve --port 10547 &
 *   NCC_HOSTING_RELAY=ws://127.0.0.1:10547 npx vitest run test/hosting-live.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
  type EventTemplate
} from 'nostr-tools'
import { buildLocatorPayload, buildLocatorTemplate, buildTombstoneTemplate, locatorContent } from '../src/shared/hosting-events'
import { shareDTag } from '../src/shared/hosting'
import { NccResolver, signerFromSecret } from '../src/main/ncc/resolver'

const relay = process.env.NCC_HOSTING_RELAY
const NOW = Math.floor(Date.now() / 1000)

describe.skipIf(!relay)('hosted services against a live relay', () => {
  it('publishes, shares, resolves and revokes', async () => {
    const pool = new SimplePool()
    const owner = generateSecretKey()
    const recipient = generateSecretKey()
    const stranger = generateSecretKey()
    const ownerHex = getPublicKey(owner)
    const recipientHex = getPublicKey(recipient)
    const ownerNpub = nip19.npubEncode(ownerHex)
    const relays = [relay as string]

    const encrypt = (peer: Uint8Array, plaintext: string, secret: Uint8Array): string =>
      nip44.encrypt(plaintext, nip44.getConversationKey(secret, getPublicKey(peer)))

    const publish = async (template: EventTemplate, secret: Uint8Array): Promise<Event> => {
      const event = finalizeEvent(template, secret)
      await pool.publish(relays, event)
      return event
    }

    const payload = locatorContent(
      buildLocatorPayload([{ url: 'https://photos.example/', priority: 1 }], 600, NOW, 'Photos')
    )
    await publish(
      buildLocatorTemplate({
        dTag: 'photos',
        ttlSeconds: 600,
        content: encrypt(owner, payload, owner),
        now: NOW,
        privateTag: true
      }),
      owner
    )

    const dTag = shareDTag('photos', recipientHex)
    await publish(
      buildLocatorTemplate({
        dTag,
        ttlSeconds: 600,
        content: encrypt(recipient, payload, owner),
        now: NOW,
        privateTag: true
      }),
      owner
    )

    await new Promise((resolve) => setTimeout(resolve, 400))

    let clock = NOW
    const resolverFor = (secret: Uint8Array) =>
      new NccResolver({
        relays: () => relays,
        gossip: () => false,
        anchorRequired: () => false,
        getSigner: () => signerFromSecret(secret),
        query: (urls, filter) => pool.querySync(urls, filter),
        now: () => clock
      })

    const ownerResult = await resolverFor(owner).resolve(ownerNpub, 'photos')
    expect(ownerResult.ok).toBe(true)
    if (ownerResult.ok) {
      expect(ownerResult.record.encrypted).toBe(true)
      expect(ownerResult.record.endpoints[0]?.url).toContain('photos.example')
      expect(ownerResult.record.notes).toBe('Photos')
    }

    const recipientResult = await resolverFor(recipient).resolve(ownerNpub, dTag)
    expect(recipientResult.ok).toBe(true)
    if (recipientResult.ok) expect(recipientResult.record.endpoints[0]?.url).toContain('photos.example')

    const strangerResult = await resolverFor(stranger).resolve(ownerNpub, dTag)
    expect(strangerResult.ok).toBe(false)
    if (!strangerResult.ok) expect(strangerResult.code).toBe('undecryptable')

    const missing = await resolverFor(owner).resolve(ownerNpub, 'share-000000000000')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('no-record')

    clock = NOW + 60
    const tombstone = buildTombstoneTemplate(dTag, clock)
    await publish(tombstone, owner)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const revoked = await resolverFor(recipient).resolve(ownerNpub, dTag)
    expect(revoked.ok).toBe(false)
    if (!revoked.ok) expect(revoked.code).toBe('expired')

    pool.close(relays)
  }, 30_000)
})
