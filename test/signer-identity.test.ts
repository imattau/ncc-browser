import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { IdentityStore, type IdentityCodec } from '../src/main/signer/identity'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-identity-')), 'identity.json')
}

function base64Codec(available = true): IdentityCodec {
  return {
    available,
    encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (cipher) => Buffer.from(cipher, 'base64').toString('utf8')
  }
}

describe('IdentityStore', () => {
  it('imports an nsec and persists it encrypted', () => {
    const file = tempFile()
    const secret = generateSecretKey()
    const store = new IdentityStore({ filePath: file, codec: base64Codec(), now: () => 1234 })

    const status = store.import(nip19.nsecEncode(secret))
    expect(status.configured).toBe(true)
    expect(status.npub).toBe(nip19.npubEncode(getPublicKey(secret)))
    expect(status.source).toBe('file')
    expect(status.persisted).toBe(true)
    expect(existsSync(file)).toBe(true)

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain([...secret].map((b) => b.toString(16).padStart(2, '0')).join(''))
    expect(JSON.parse(raw).ciphertext).toBeTruthy()
  })

  it('loads a stored identity in a new instance', () => {
    const file = tempFile()
    const secret = generateSecretKey()
    new IdentityStore({ filePath: file, codec: base64Codec() }).import(nip19.nsecEncode(secret))

    const reloaded = new IdentityStore({ filePath: file, codec: base64Codec() })
    expect(reloaded.status().npub).toBe(nip19.npubEncode(getPublicKey(secret)))
    expect([...reloaded.getSecret()!]).toEqual([...secret])
  })

  it('generates a new identity', () => {
    const store = new IdentityStore({ filePath: tempFile(), codec: base64Codec() })
    const status = store.generate()
    expect(status.configured).toBe(true)
    expect(status.npub?.startsWith('npub1')).toBe(true)
  })

  it('keeps the key in memory when no keychain is available', () => {
    const file = tempFile()
    const store = new IdentityStore({ filePath: file, codec: base64Codec(false) })
    const status = store.import(nip19.nsecEncode(generateSecretKey()))
    expect(status.source).toBe('session')
    expect(status.persisted).toBe(false)
    expect(status.encryptionAvailable).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(store.getSecret()).not.toBeNull()
  })

  it('removes the identity and the stored file', () => {
    const file = tempFile()
    const store = new IdentityStore({ filePath: file, codec: base64Codec() })
    store.generate()
    const status = store.remove()
    expect(status.configured).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('ignores a corrupt or undecryptable file', () => {
    const file = tempFile()
    writeFileSync(file, 'garbage')
    expect(new IdentityStore({ filePath: file, codec: base64Codec() }).status().configured).toBe(
      false
    )

    writeFileSync(file, JSON.stringify({ version: 1, ciphertext: 'not-base64-json' }))
    const codec = base64Codec()
    codec.decrypt = () => {
      throw new Error('bad key')
    }
    expect(new IdentityStore({ filePath: file, codec }).status().configured).toBe(false)
  })

  it('lets the environment override a stored identity', () => {
    const file = tempFile()
    const store = new IdentityStore({ filePath: file, codec: base64Codec() })
    store.generate()
    const envSecret = generateSecretKey()
    const status = store.setFromEnv(nip19.nsecEncode(envSecret))
    expect(status.source).toBe('env')
    expect(status.npub).toBe(nip19.npubEncode(getPublicKey(envSecret)))
  })

  it('provides a locator signer', async () => {
    const store = new IdentityStore({ filePath: tempFile(), codec: base64Codec() })
    store.generate()
    const signer = store.getSigner()
    expect(signer).not.toBeNull()
    expect(await signer!.getPublicKey()).toBe(store.status().hexPubkey)
  })
})
