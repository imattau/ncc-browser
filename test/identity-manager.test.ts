import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { IdentityManager } from '../src/main/signer/manager'
import { IdentityStore, type IdentityCodec } from '../src/main/signer/identity'
import { Nip46SessionStore } from '../src/main/signer/session'
import { RemoteIdentityProvider, type RemoteSignerLike } from '../src/main/signer/nip46'
import type { EventTemplate } from '../src/main/signer/crypto'

const REMOTE_SK = generateSecretKey()
const REMOTE_PK = getPublicKey(REMOTE_SK)
const REMOTE_NPUB = nip19.npubEncode(REMOTE_PK)

const BUNKER = `bunker://${REMOTE_PK}?relay=${encodeURIComponent('wss://relay.example')}&secret=abc`

function base64Codec(): IdentityCodec {
  return {
    available: true,
    encrypt: async (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: async (cipher) => Buffer.from(cipher, 'base64').toString('utf8')
  }
}

function fakeSigner(): RemoteSignerLike {
  return {
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
    close: vi.fn(async () => undefined)
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ncc-manager-'))
}

async function makeManager(directory = tempDir(), signer = fakeSigner()) {
  const local = await IdentityStore.open({
    filePath: join(directory, 'identity.json'),
    codec: base64Codec()
  })
  const sessions = new Nip46SessionStore(join(directory, 'nip46-session.json'), base64Codec())
  const manager = await IdentityManager.create({
    local,
    sessions,
    encryptionAvailable: true,
    remoteFactory: (args) =>
      new RemoteIdentityProvider({ ...args, createSigner: () => signer })
  })
  return { manager, local, sessions, signer, directory }
}

describe('IdentityManager', () => {
  it('starts with no identity', async () => {
    const { manager } = await makeManager()
    expect(manager.status().mode).toBe('none')
    expect(manager.provider()).toBeNull()
  })

  it('generates and uses a local identity', async () => {
    const { manager } = await makeManager()
    const status = await manager.generateLocal()
    expect(status.mode).toBe('local')
    expect(status.persisted).toBe(true)
    expect(manager.provider()).not.toBeNull()
  })

  it('connects a remote signer and persists the session', async () => {
    const { manager, sessions, signer, directory } = await makeManager()
    const status = await manager.connectRemote(BUNKER)

    expect(status.mode).toBe('nip46')
    expect(status.npub).toBe(REMOTE_NPUB)
    expect(status.persisted).toBe(true)
    expect(signer.connect).toHaveBeenCalledWith('abc')

    const event = await manager.provider()!.signEvent({
      kind: 1,
      created_at: 1,
      tags: [],
      content: 'x'
    })
    expect(event.pubkey).toBe(REMOTE_PK)

    const loaded = await new Nip46SessionStore(
      join(directory, 'nip46-session.json'),
      base64Codec()
    ).load()
    expect(loaded?.target.remotePubkey).toBe(REMOTE_PK)
    expect(sessions).toBeTruthy()
  })

  it('restores a saved session without connecting until needed', async () => {
    const directory = tempDir()
    const first = await makeManager(directory, fakeSigner())
    await first.manager.connectRemote(BUNKER)

    const second = await makeManager(directory, fakeSigner())
    const status = second.manager.status()
    expect(status.mode).toBe('nip46')
    expect(status.npub).toBe(REMOTE_NPUB)
    expect(status.connected).toBe(false)

    await second.manager.provider()!.getPublicKey()
    // getPublicKey does not need a round-trip; signing does.
    await second.manager.provider()!.signEvent({ kind: 1, created_at: 1, tags: [], content: 'x' })
    expect(second.signer.connect).toHaveBeenCalledTimes(1)
  })

  it('disconnects back to the local identity', async () => {
    const { manager } = await makeManager()
    const local = await manager.generateLocal()
    await manager.connectRemote(BUNKER)
    expect(manager.status().mode).toBe('nip46')

    const status = await manager.disconnectRemote()
    expect(status.mode).toBe('local')
    expect(status.npub).toBe(local.npub)
    expect(manager.provider()).not.toBeNull()
  })

  it('importing a local key replaces an active remote signer', async () => {
    const { manager, signer } = await makeManager()
    await manager.connectRemote(BUNKER)

    const secret = generateSecretKey()
    const status = await manager.importLocal(nip19.nsecEncode(secret))
    expect(status.mode).toBe('local')
    expect(status.npub).toBe(nip19.npubEncode(getPublicKey(secret)))
    expect(signer.close).toHaveBeenCalled()
  })

  it('exposes a locator signer that decrypts remotely', async () => {
    const { manager, signer } = await makeManager()
    await manager.connectRemote(BUNKER)

    const locator = manager.locatorSigner()
    expect(locator).not.toBeNull()
    await expect(locator!.decrypt44!(REMOTE_PK, 'cipher')).resolves.toBe('nip44-plain')
    expect(signer.nip44.decrypt).toHaveBeenCalledWith(REMOTE_PK, 'cipher')
  })
})
