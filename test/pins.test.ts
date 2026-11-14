import { describe, expect, it } from 'vitest'
import { PinStore, spkiFingerprintFromPem } from '../src/main/pins'
import selfsigned from 'selfsigned'

describe('PinStore', () => {
  it('stores and retrieves pins case-insensitively', () => {
    const store = new PinStore()
    store.set('Relay.Example', { k: 'abc', label: 'npub/service' })
    expect(store.get('relay.example')?.k).toBe('abc')
    expect(store.size()).toBe(1)
  })

  it('clears a host and its rejection', () => {
    const store = new PinStore()
    store.set('a.example', { k: 'abc', label: 'x' })
    store.recordRejection('a.example', 'pin-mismatch')
    store.clearHost('A.example')
    expect(store.get('a.example')).toBeUndefined()
    expect(store.consumeRejection('a.example')).toBeUndefined()
  })

  it('consumes a rejection exactly once', () => {
    const store = new PinStore()
    store.recordRejection('a.example', 'pin-mismatch')
    expect(store.consumeRejection('a.example')?.reason).toBe('pin-mismatch')
    expect(store.consumeRejection('a.example')).toBeUndefined()
  })

  it('ignores stale rejections', () => {
    const store = new PinStore()
    store.recordRejection('a.example', 'expired-cert')
    expect(store.consumeRejection('a.example', -1)).toBeUndefined()
  })

  it('clears everything', () => {
    const store = new PinStore()
    store.set('a.example', { k: 'abc', label: 'x' })
    store.clear()
    expect(store.size()).toBe(0)
  })
})

describe('spkiFingerprintFromPem', () => {
  it('returns a base64url sha256 of the SPKI, matching the NCC k format', async () => {
    const notAfterDate = new Date(Date.now() + 86_400_000)
    const cert = await selfsigned.generate([{ name: 'commonName', value: 'test.example' }], {
      notAfterDate,
      keySize: 2048
    })
    const k = spkiFingerprintFromPem(cert.cert)
    expect(k).toBeTypeOf('string')
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const other = await selfsigned.generate([{ name: 'commonName', value: 'other.example' }], {
      notAfterDate,
      keySize: 2048
    })
    expect(spkiFingerprintFromPem(other.cert)).not.toBe(k)
  })

  it('returns null for junk', () => {
    expect(spkiFingerprintFromPem('not a certificate')).toBeNull()
  })
})
