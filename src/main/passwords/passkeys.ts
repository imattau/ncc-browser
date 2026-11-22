import { createHash, generateKeyPairSync, sign as signBytes, createPrivateKey, randomBytes, type JsonWebKey } from 'node:crypto'
import { isIP } from 'node:net'
import { getDomain } from 'tldts'
import type { PasskeyCredential } from '@shared/passwords'
import { encodeCbor } from './cbor'

export interface PasskeyCreationOptions {
  challenge: string
  rp?: { id?: string; name?: string }
  user?: { id?: string; name?: string; displayName?: string }
  pubKeyCredParams?: Array<{ type?: string; alg?: number }>
  excludeCredentials?: Array<{ id?: string }>
  authenticatorSelection?: { residentKey?: string; requireResidentKey?: boolean; userVerification?: string }
}

export interface PasskeyRequestOptions {
  challenge: string
  rpId?: string
  allowCredentials?: Array<{ id?: string }>
  userVerification?: string
}

export function validateRpId(origin: string, rpId?: string): string {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Passkeys require a secure top-level https page')
  const host = url.hostname.toLowerCase()
  const rpInput = (rpId || host).toLowerCase().replace(/\.$/, '')
  let rp: string
  try { rp = new URL(`https://${rpInput}`).hostname.toLowerCase() } catch { throw new Error('The relying-party ID is not valid for this page') }
  const localHost = host === 'localhost' && rp === 'localhost'
  const registrableDomain = getDomain(rp, { extractHostname: false, allowPrivateDomains: true })
  if (!rp || isIP(rp) || (!localHost && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rp)) || !(host === rp || host.endsWith(`.${rp}`)) || (!localHost && rp !== host && registrableDomain !== rp)) {
    throw new Error('The relying-party ID is not valid for this page')
  }
  return rp
}

export function makeCredential(options: PasskeyCreationOptions, origin: string, rpId: string): { credential: PasskeyCredential; response: Record<string, string> } {
  if (!options.user || typeof options.user.name !== 'string' || typeof options.user.id !== 'string') throw new Error('The relying party supplied invalid user details')
  const userHandleBytes = fromB64(options.user.id)
  if (userHandleBytes.length < 1 || userHandleBytes.length > 64) throw new Error('The relying party supplied an invalid user handle')
  if (options.pubKeyCredParams && !options.pubKeyCredParams.some((param) => param.type === 'public-key' && param.alg === -7)) throw new Error('This relying party does not accept NCC’s ES256 passkeys')
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  const privateJwk = privateKey.export({ format: 'jwk' }) as JsonWebKey
  const credentialId = random(32)
  const userHandle = b64(userHandleBytes)
  const clientDataJSON = clientData('webauthn.create', options.challenge, origin)
  const coseKey = encodeCbor({ 1: 2, 3: -7, '-1': 1, '-2': fromB64(publicJwk.x!), '-3': fromB64(publicJwk.y!) })
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    // The NCC passkey confirmation prompt verifies user intent for this
    // operation; report UP + UV + BE + AT. No extension data is included.
    Buffer.from([0x4d]),
    uint32(0),
    Buffer.alloc(16),
    uint16(credentialId.length),
    credentialId,
    coseKey
  ])
  const attestationObject = encodeCbor({ fmt: 'none', attStmt: {}, authData })
  return {
    credential: {
      credentialId: b64(credentialId), rpId, userHandle,
      userName: options.user.name.slice(0, 320), userDisplayName: (options.user.displayName || options.user.name).slice(0, 200),
      privateKeyJwk: privateJwk, publicKeyJwk: publicJwk, signCount: 0,
      discoverable: options.authenticatorSelection?.residentKey !== 'discouraged' || options.authenticatorSelection?.requireResidentKey === true
    },
    response: { id: b64(credentialId), rawId: b64(credentialId), type: 'public-key', clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), publicKey: b64(publicKey.export({ format: 'der', type: 'spki' })), transports: 'internal' }
  }
}

export function makeAssertion(credential: PasskeyCredential, challenge: string, origin: string, userVerification: string | undefined): { response: Record<string, string>; signCount: number } {
  const clientDataJSON = clientData('webauthn.get', challenge, origin)
  // Vault-synced credentials are multi-device credentials. Keep the counter at
  // zero so concurrent devices do not produce false rollback detections.
  const count = 0
  // NCC requires an explicit in-browser confirmation for each passkey use,
  // which is the user-verification step for this software authenticator.
  const authData = Buffer.concat([createHash('sha256').update(credential.rpId).digest(), Buffer.from([0x1d]), uint32(count)])
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()])
  const signature = signBytes('sha256', signed, { key: createPrivateKey({ key: credential.privateKeyJwk as JsonWebKey, format: 'jwk' }), dsaEncoding: 'der' })
  return {
    signCount: count,
    response: {
      id: credential.credentialId, rawId: credential.credentialId, type: 'public-key',
      clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature), userHandle: credential.userHandle
    }
  }
}

export function clientData(type: string, challenge: string, origin: string): Buffer {
  const challengeBytes = fromB64(challenge)
  if (challengeBytes.length < 16 || challengeBytes.length > 1024) throw new Error('The relying party supplied an invalid challenge')
  return Buffer.from(JSON.stringify({ type, challenge: b64(challengeBytes), origin, crossOrigin: false }), 'utf8')
}

export function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url') }
export function fromB64(value: string): Buffer {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid WebAuthn byte sequence')
  return Buffer.from(value, 'base64url')
}
function random(length: number): Buffer { return randomBytes(length) }
function uint16(value: number): Buffer { const out = Buffer.alloc(2); out.writeUInt16BE(value); return out }
function uint32(value: number): Buffer { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out }
