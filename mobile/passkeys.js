import { getDomain } from 'tldts'

const encoder = new TextEncoder()

export function validateRpId(origin, input) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Passkeys require a secure top-level https page')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const rpId = String(input || host).toLowerCase().replace(/\.$/, '')
  const localhost = host === 'localhost' && rpId === 'localhost'
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(rpId) || rpId.includes(':')
  const domain = getDomain(rpId, { allowPrivateDomains: true, extractHostname: false })
  if (!rpId || isIp || (!localhost && !domain) || !(host === rpId || host.endsWith(`.${rpId}`))) {
    throw new Error('The relying-party ID is not valid for this page')
  }
  return rpId
}

function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array()
}

function b64url(value) {
  const input = bytes(value)
  let binary = ''
  for (let offset = 0; offset < input.length; offset += 0x8000) {
    binary += String.fromCharCode(...input.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromB64url(value) {
  const source = String(value || '')
  const binary = atob(source.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - source.length % 4) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function cborHead(major, value) {
  if (value < 24) return Uint8Array.of((major << 5) | value)
  if (value <= 0xff) return Uint8Array.of((major << 5) | 24, value)
  if (value <= 0xffff) return Uint8Array.of((major << 5) | 25, value >> 8, value & 255)
  return Uint8Array.of((major << 5) | 26, value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255)
}

function cbor(value) {
  if (value instanceof Uint8Array) return join(cborHead(2, value.length), value)
  if (typeof value === 'string') {
    const encoded = encoder.encode(value)
    return join(cborHead(3, encoded.length), encoded)
  }
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (Array.isArray(value)) return join(cborHead(4, value.length), ...value.map(cbor))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    return join(cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [cborKey(key), cbor(item)]))
  }
  if (value === null) return Uint8Array.of(0xf6)
  throw new TypeError('Unsupported CBOR value')
}

function cborKey(key) {
  if (/^(0|[1-9]\d*)$/.test(key)) return cbor(Number(key))
  if (/^-[1-9]\d*$/.test(key)) return cbor(Number(key))
  return cbor(key)
}

function join(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

function uint32(value) {
  return Uint8Array.of(value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255)
}

function toDer(raw) {
  const input = bytes(raw)
  const integer = (part) => {
    let first = 0
    while (first < part.length - 1 && part[first] === 0) first++
    let value = part.subarray(first)
    if (value[0] & 0x80) value = join(Uint8Array.of(0), value)
    return join(Uint8Array.of(2, value.length), value)
  }
  const r = integer(input.subarray(0, 32))
  const s = integer(input.subarray(32, 64))
  return join(Uint8Array.of(0x30, r.length + s.length), r, s)
}

function clientData(type, challenge, origin) {
  return encoder.encode(JSON.stringify({ type, challenge: b64url(fromB64url(challenge)), origin, crossOrigin: false }))
}

async function rpHash(rpId) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)))
}

export async function makeVaultPasskey(options, origin) {
  const rpId = validateRpId(origin, options.rp?.id)
  if (!options.user?.id || !options.user?.name) throw new Error('The relying party supplied invalid user details')
  if (options.pubKeyCredParams && !options.pubKeyCredParams.some((item) => item.type === 'public-key' && item.alg === -7)) throw new Error('This site does not accept NCC’s ES256 passkeys')
  const userId = fromB64url(options.user.id)
  if (userId.length < 1 || userId.length > 64) throw new Error('The relying party supplied an invalid user handle')
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicSpki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32))
  const credentialId = b64url(credentialIdBytes)
  const key = cbor({ 1: 2, 3: -7, '-1': 1, '-2': fromB64url(publicKeyJwk.x), '-3': fromB64url(publicKeyJwk.y) })
  const rpIdHash = await rpHash(rpId)
  const flags = Uint8Array.of(0x4d)
  const authData = join(rpIdHash, flags, uint32(0), new Uint8Array(16), Uint8Array.of(0, credentialIdBytes.length), credentialIdBytes, key)
  const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData })
  const response = {
    id: credentialId,
    rawId: b64url(credentialIdBytes),
    type: 'public-key',
    clientDataJSON: b64url(clientData('webauthn.create', options.challenge, origin)),
    attestationObject: b64url(attestationObject),
    publicKey: b64url(publicSpki),
    transports: ['internal']
  }
  return {
    record: {
      credentialId,
      rpId,
      userHandle: b64url(userId),
      userName: options.user.name.slice(0, 320),
      userDisplayName: (options.user.displayName || options.user.name).slice(0, 200),
      privateKeyJwk,
      publicKeyJwk,
      signCount: 0,
      discoverable: options.authenticatorSelection?.residentKey !== 'discouraged' || options.authenticatorSelection?.requireResidentKey === true
    },
    response
  }
}

export async function makeVaultAssertion(record, challenge, origin, userVerification) {
  if (userVerification === 'required' && !record.privateKeyJwk?.d) throw new Error('NotAllowedError')
  const privateKey = await crypto.subtle.importKey('jwk', record.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const client = clientData('webauthn.get', challenge, origin)
  const authData = join(await rpHash(record.rpId), Uint8Array.of(0x1d), uint32(0))
  const signature = toDer(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, join(authData, new Uint8Array(await crypto.subtle.digest('SHA-256', client)))))
  return {
    id: record.credentialId,
    rawId: record.credentialId,
    type: 'public-key',
    clientDataJSON: b64url(client),
    authenticatorData: b64url(authData),
    signature: b64url(signature),
    userHandle: record.userHandle || null
  }
}
