import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Nip46SessionStore } from '../src/main/signer/session'
import type { IdentityCodec } from '../src/main/signer/identity'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-nip46-')), 'nip46-session.json')
}

function base64Codec(available = true): IdentityCodec {
  return {
    available,
    encrypt: async (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: async (cipher) => Buffer.from(cipher, 'base64').toString('utf8')
  }
}

const REMOTE_PK = getPublicKey(generateSecretKey())
const CLIENT_SECRET = '11'.repeat(32)

function session() {
  return {
    target: { remotePubkey: REMOTE_PK, relays: ['wss://relay.example'], secret: 'abc' },
    clientSecret: CLIENT_SECRET,
    createdAt: 1234
  }
}

describe('Nip46SessionStore', () => {
  it('saves and loads a session', async () => {
    const file = tempFile()
    const store = new Nip46SessionStore(file, base64Codec())
    await expect(store.save(session())).resolves.toBe(true)
    expect(existsSync(file)).toBe(true)

    const loaded = await new Nip46SessionStore(file, base64Codec()).load()
    expect(loaded?.target.remotePubkey).toBe(REMOTE_PK)
    expect(loaded?.target.relays).toEqual(['wss://relay.example'])
    expect(loaded?.target.secret).toBe('abc')
    expect(loaded?.clientSecret).toBe(CLIENT_SECRET)
  })

  it('is ephemeral when no keychain exists', async () => {
    const file = tempFile()
    const store = new Nip46SessionStore(file, base64Codec(false))
    await expect(store.save(session())).resolves.toBe(false)
    expect(existsSync(file)).toBe(false)
    await expect(store.load()).resolves.toBeNull()
  })

  it('clears the session file', async () => {
    const file = tempFile()
    const store = new Nip46SessionStore(file, base64Codec())
    await store.save(session())
    store.clear()
    expect(existsSync(file)).toBe(false)
    await expect(store.load()).resolves.toBeNull()
  })

  it('ignores a corrupt or undecryptable session', async () => {
    const file = tempFile()
    const store = new Nip46SessionStore(file, base64Codec())
    await store.save(session())

    const codec = base64Codec()
    codec.decrypt = async () => {
      throw new Error('keychain changed')
    }
    await expect(new Nip46SessionStore(file, codec).load()).resolves.toBeNull()
  })
})
