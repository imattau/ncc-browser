import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeAssertion, makeCredential } from '../src/main/passwords/passkeys'

const b64url = (value: Buffer): string => value.toString('base64url')

describe('NCC WebAuthn credentials', () => {
  it('creates a discoverable ES256 credential and signs required-UV assertions after approval', () => {
    const origin = 'https://example.com'
    const challenge = b64url(Buffer.alloc(32, 7))
    const made = makeCredential({
      challenge,
      rp: { id: 'example.com', name: 'Example' },
      user: { id: b64url(Buffer.from('user-1')), name: 'alice@example.com' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    }, origin, 'example.com')

    expect(made.credential.discoverable).toBe(true)
    expect(made.response.transports).toBe('internal')

    const assertion = makeAssertion(made.credential, challenge, origin, 'required')
    const clientDataJSON = Buffer.from(assertion.response.clientDataJSON, 'base64url')
    const clientData = JSON.parse(clientDataJSON.toString('utf8')) as Record<string, string>
    const authenticatorData = Buffer.from(assertion.response.authenticatorData, 'base64url')
    const signature = Buffer.from(assertion.response.signature, 'base64url')

    expect(clientData).toMatchObject({ type: 'webauthn.get', challenge, origin, crossOrigin: false })
    expect(authenticatorData.subarray(0, 32)).toEqual(createHash('sha256').update('example.com').digest())
    expect(authenticatorData[32] & 0x04).toBe(0x04) // user verified after NCC confirmation
    expect(authenticatorData[32] & 0x08).toBe(0x08) // backup eligible
    expect(authenticatorData[32] & 0x10).toBe(0x10) // backed up / vault-synced

    const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()])
    const publicKey = createPublicKey({ key: made.credential.publicKeyJwk as JsonWebKey, format: 'jwk' })
    expect(verify('sha256', signed, publicKey, signature)).toBe(true)
  })
})
