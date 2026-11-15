import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import type { RelayEntry } from '../src/shared/types'
import type { IdentityCodec } from '../src/main/signer/identity'
import type { IdentityStore } from '../src/main/signer/identity'
import { IdentityManager } from '../src/main/signer/manager'
import type { BunkerTarget, RemoteIdentityProvider } from '../src/main/signer/nip46'
import { Nip46SessionStore } from '../src/main/signer/session'

const REMOTE_PK = getPublicKey(generateSecretKey())
const NPUB = nip19.npubEncode(REMOTE_PK)
const RESOLVED_URL = 'wss://resolved.example'

function codec(): IdentityCodec {
  return {
    available: true,
    encrypt: async (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: async (cipher) => Buffer.from(cipher, 'base64').toString('utf8')
  }
}

function sessions(): Nip46SessionStore {
  return new Nip46SessionStore(
    join(mkdtempSync(join(tmpdir(), 'ncc-bunker-')), 'nip46-session.json'),
    codec()
  )
}

function localStore(): IdentityStore {
  return {
    status: () => ({
      configured: false,
      mode: 'none',
      source: 'none',
      persisted: false,
      encryptionAvailable: false
    })
  } as unknown as IdentityStore
}

function resolvedEntry(): RelayEntry {
  return {
    url: RESOLVED_URL,
    locator: {
      identity: `ncc://${NPUB}/relay`,
      pubkey: REMOTE_PK,
      service: 'relay',
      dTag: 'relay',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      k: 'cGlu'
    }
  }
}

function fakeRemote(seen: BunkerTarget[]): (args: {
  target: BunkerTarget
}) => RemoteIdentityProvider {
  return (args) => {
    const target = args.target
    seen.push(target)
    return {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      status: () => ({
        configured: true,
        mode: 'nip46' as const,
        npub: NPUB,
        hexPubkey: REMOTE_PK,
        source: 'session' as const,
        persisted: false,
        encryptionAvailable: false,
        relays: [...target.relays],
        connected: true
      }),
      setPersisted: vi.fn(),
      relayEntries: () => target.entries ?? target.relays.map((url) => ({ url })),
      sessionTarget: () => target,
      setRelayEntries: (entries: RelayEntry[]) => {
        target.entries = entries
        target.relays = entries.map((entry) => entry.url)
      }
    } as unknown as RemoteIdentityProvider
  }
}

describe('NIP-46 relay locators', () => {
  it('resolves ncc:// bunker relays and keeps the plain ones', async () => {
    const store = sessions()
    const seen: BunkerTarget[] = []
    const pins = vi.fn()
    const manager = new IdentityManager({
      local: localStore(),
      sessions: store,
      encryptionAvailable: false,
      remoteFactory: fakeRemote(seen),
      resolveRelayLocator: async () => resolvedEntry(),
      onRelayEntriesChanged: pins
    })

    await manager.connectRemote(
      `bunker://${REMOTE_PK}?relay=${encodeURIComponent(`ncc://${NPUB}/relay`)}&relay=${encodeURIComponent('wss://plain.example')}`
    )

    expect(seen).toHaveLength(1)
    expect(seen[0].relays).toEqual([RESOLVED_URL, 'wss://plain.example'])
    expect(seen[0].entries).toEqual([
      resolvedEntry(),
      { url: 'wss://plain.example' }
    ])

    // Pins are registered before the connect attempt and again after it.
    expect(pins).toHaveBeenCalled()
    expect(pins.mock.calls[0][0]).toContainEqual(
      expect.objectContaining({ url: RESOLVED_URL, locator: expect.objectContaining({ k: 'cGlu' }) })
    )

    const saved = await store.load()
    expect(saved?.target.entries).toEqual([
      resolvedEntry(),
      { url: 'wss://plain.example' }
    ])
  })

  it('refuses to connect when the locator cannot be resolved', async () => {
    const seen: BunkerTarget[] = []
    const manager = new IdentityManager({
      local: localStore(),
      sessions: sessions(),
      encryptionAvailable: false,
      remoteFactory: fakeRemote(seen),
      resolveRelayLocator: async () => null
    })

    await expect(
      manager.connectRemote(`bunker://${REMOTE_PK}?relay=${encodeURIComponent(`ncc://${NPUB}/relay`)}`)
    ).rejects.toThrow(/Could not resolve the bunker relay/)
    expect(seen).toHaveLength(0)
  })
})
