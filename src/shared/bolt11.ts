import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** Decode the public BOLT11 fields needed to review a Lightning payment. */
export interface Bolt11Review {
  invoice: string
  network: 'mainnet' | 'testnet' | 'regtest'
  amountMsat: string | null
  description: string | null
  descriptionHash: string | null
  payee: string | null
  createdAt: number
  expiresAt: number
  expired: boolean
}

const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= generators[i]
  }
  return checksum >>> 0
}

function wordsToBytes(words: number[], pad = false): Uint8Array {
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  for (const word of words) {
    accumulator = (accumulator << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >>> bits) & 255)
    }
    accumulator &= (1 << bits) - 1
  }
  if (!pad && (bits >= 5 || ((accumulator << (8 - bits)) & 255) !== 0)) throw new Error('Invalid Lightning invoice data')
  return Uint8Array.from(bytes)
}

function text(words: number[]): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(wordsToBytes(words, true))
}

function integer(words: number[]): number {
  let value = 0n
  for (const word of words) value = (value << 5n) | BigInt(word)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Lightning invoice field is too large')
  return Number(value)
}

/** Checks the Bech32 checksum and BOLT11 signature, then decodes payment metadata. */
export function decodeBolt11Invoice(value: string, now = Math.floor(Date.now() / 1000)): Bolt11Review {
  const invoice = value.trim().replace(/^lightning:/i, '')
  if (!invoice || invoice.length > 4096 || (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase())) {
    throw new Error('Enter a valid Lightning invoice')
  }
  const normalized = invoice.toLowerCase()
  const separator = normalized.lastIndexOf('1')
  if (separator < 1 || normalized.length - separator < 7) throw new Error('Invalid Lightning invoice checksum')
  const hrp = normalized.slice(0, separator)
  const prefix = /^ln(bcrt|bc|tb)(.*)$/.exec(hrp)
  if (!prefix) throw new Error('Unsupported Lightning invoice network')
  const payload = [...normalized.slice(separator + 1)].map((char) => {
    const word = charset.indexOf(char)
    if (word < 0) throw new Error('Invalid Lightning invoice character')
    return word
  })
  const expandedHrp = [...hrp].map((char) => char.charCodeAt(0) >>> 5)
    .concat([0], [...hrp].map((char) => char.charCodeAt(0) & 31))
  if (polymod(expandedHrp.concat(payload)) !== 1) throw new Error('Invalid Lightning invoice checksum')
  const amountText = prefix[2]
  const amountMatch = /^(\d+)?([munp])?$/.exec(amountText)
  if (!amountMatch || Boolean(amountMatch[1]) !== Boolean(amountMatch[2])) throw new Error('Invalid Lightning invoice amount')
  let amountMsat: string | null = null
  if (amountMatch[1]) {
    const unit = amountMatch[2]
    const amount = BigInt(amountMatch[1])
    if (amount <= 0n) throw new Error('Lightning invoice amount must be positive')
    const multipliers: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n }
    const msat = unit === 'p' ? amount / 10n : amount * (multipliers[unit] ?? 100_000_000_000n)
    if (unit === 'p' && amount % 10n !== 0n) throw new Error('Lightning invoice amount is below one millisatoshi')
    amountMsat = msat.toString()
  }
  const data = payload.slice(0, -110)
  const signature = wordsToBytes(payload.slice(-110, -6), true)
  if (signature.length !== 65 || signature[64] > 3) throw new Error('Invalid Lightning invoice signature')
  const digestInput = new Uint8Array(new TextEncoder().encode(hrp).length + wordsToBytes(data, true).length)
  const hrpBytes = new TextEncoder().encode(hrp)
  digestInput.set(hrpBytes)
  digestInput.set(wordsToBytes(data, true), hrpBytes.length)
  const digest = sha256(digestInput)
  const recoveredPayee = secp256k1.Signature.fromBytes(signature.slice(0, 64), 'compact')
    .addRecoveryBit(signature[64]).recoverPublicKey(digest).toBytes(true)
  if (data.length < 7) throw new Error('Lightning invoice is incomplete')
  const createdAt = integer(data.slice(0, 7))
  let description: string | null = null
  let descriptionHash: string | null = null
  let payee: string | null = null
  let expiry = 3600
  let hasPaymentHash = false
  let hasPaymentSecret = false
  let hasDescription = false
  for (let offset = 7; offset < data.length;) {
    if (offset + 3 > data.length) throw new Error('Malformed Lightning invoice fields')
    const tag = charset[data[offset++]]
    const length = (data[offset++] << 5) | data[offset++]
    if (offset + length > data.length) throw new Error('Malformed Lightning invoice fields')
    const field = data.slice(offset, offset + length)
    offset += length
    if (tag === 'p' || tag === 's') {
      if (field.length !== 52) throw new Error(`Malformed Lightning invoice ${tag} field`)
      if (tag === 'p') {
        if (hasPaymentHash) throw new Error('Duplicate Lightning invoice payment hash')
        hasPaymentHash = true
      } else {
        if (hasPaymentSecret) throw new Error('Duplicate Lightning invoice payment secret')
        hasPaymentSecret = true
      }
    }
    if (tag === 'd' || tag === 'h') {
      if (hasDescription) throw new Error('Lightning invoice has multiple descriptions')
      hasDescription = true
      if (tag === 'd') description = text(field)
      else {
        if (field.length !== 52) throw new Error('Malformed Lightning invoice description hash')
        descriptionHash = [...wordsToBytes(field)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      }
    }
    if (tag === 'n') {
      if (field.length !== 53) throw new Error('Malformed Lightning invoice payee')
      payee = [...wordsToBytes(field)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    if (tag === 'x') expiry = integer(field)
  }
  if (!hasPaymentHash || !hasPaymentSecret || !hasDescription) throw new Error('Lightning invoice is missing required payment details')
  const recoveredHex = [...recoveredPayee].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (payee && payee !== recoveredHex) throw new Error('Lightning invoice signature does not match its payee')
  payee ??= recoveredHex
  const expiresAt = createdAt + expiry
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Lightning invoice expiry is invalid')
  return {
    invoice: normalized,
    network: prefix[1] === 'bc' ? 'mainnet' : prefix[1] === 'tb' ? 'testnet' : 'regtest',
    amountMsat,
    description,
    descriptionHash,
    payee,
    createdAt,
    expiresAt,
    expired: expiresAt <= now
  }
}

