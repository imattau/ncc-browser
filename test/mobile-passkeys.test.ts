import { createHash, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeVaultAssertion, makeVaultPasskey, validateRpId } from '../mobile/passkeys.js'

const base64url = (value: Uint8Array): string => Buffer.from(value).toString('base64url')

describe('Android NCC vault passkeys', () => {
  it('accepts a site RP ID and rejects a public suffix', () => {
    expect(validateRpId('https://accounts.google.com', 'google.com')).toBe('google.com')
    expect(() => validateRpId('https://login.example.co.uk', 'co.uk')).toThrow(/relying-party ID/)
  })

  it('creates a vault record and an assertion that verifies with its public key', async () => {
    const options = {
      challenge: base64url(new Uint8Array(32).fill(7)),
      rp: { id: 'webauthn.io', name: 'WebAuthn.io' },
      user: { id: base64url(Uint8Array.of(1, 2, 3)), name: 'ncc-passkey-smoke-test', displayName: 'NCC smoke test' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred' }
    }
    const made = await makeVaultPasskey(options, 'https://webauthn.io')
    expect(made.record.discoverable).toBe(true)
    expect(made.response.id).toBe(made.record.credentialId)
    expect(made.response.attestationObject).toBeTruthy()

    const assertion = await makeVaultAssertion(
      made.record,
      base64url(new Uint8Array(32).fill(9)),
      'https://webauthn.io',
      'required'
    )
    const clientData = Buffer.from(assertion.clientDataJSON, 'base64url')
    const authenticatorData = Buffer.from(assertion.authenticatorData, 'base64url')
    const signedData = Buffer.concat([
      authenticatorData,
      createHash('sha256').update(clientData).digest()
    ])
    expect(
      verify(
        'sha256',
        signedData,
        createPublicKey({ key: made.record.publicKeyJwk, format: 'jwk' }),
        Buffer.from(assertion.signature, 'base64url')
      )
    ).toBe(true)
  })
})
