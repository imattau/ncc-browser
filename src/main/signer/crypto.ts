/**
 * NIP-07 signing primitives. Pure functions over a secret key, so the security-
 * sensitive behaviour is unit-testable without Electron.
 */

import {
  finalizeEvent,
  getPublicKey,
  nip04,
  nip19,
  nip44,
  type Event
} from 'nostr-tools'

const MAX_CONTENT_BYTES = 1_000_000
const MAX_TAGS = 2_000
const MAX_TAG_VALUES = 64
const MAX_FUTURE_SECONDS = 900

export class SignerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerError'
  }
}

export function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value)
}

export function parseSecretKey(input: string): Uint8Array {
  const value = input.trim()
  if (!value) throw new SignerError('Enter an nsec or a 64-character hex key')

  if (/^[0-9a-f]{64}$/i.test(value)) {
    const bytes = new Uint8Array(32)
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    }
    return bytes
  }

  if (value.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type !== 'nsec') throw new Error('not an nsec')
      return decoded.data as Uint8Array
    } catch {
      throw new SignerError('That nsec is not valid')
    }
  }

  throw new SignerError('Expected an nsec1… or 64-character hex secret key')
}

export function npubOf(secret: Uint8Array): string {
  return nip19.npubEncode(getPublicKey(secret))
}

export function hexPubkeyOf(secret: Uint8Array): string {
  return getPublicKey(secret)
}

export function secretKeyToHex(secret: Uint8Array): string {
  return [...secret].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface EventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

/**
 * Validate and normalise an event template coming from page JavaScript. The page
 * controls every field, so this is a trust boundary: reject nonsense early and bound
 * the amount of data the user can be tricked into signing.
 */
export function validateTemplate(
  input: unknown,
  now: number = Math.floor(Date.now() / 1000)
): EventTemplate {
  if (!input || typeof input !== 'object') throw new SignerError('Event must be an object')
  const raw = input as Record<string, unknown>

  const kind = Number(raw.kind)
  if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
    throw new SignerError('Event kind must be an integer between 0 and 65535')
  }

  const createdAt = raw.created_at === undefined ? now : Number(raw.created_at)
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    throw new SignerError('Event created_at must be a positive integer')
  }
  if (createdAt > now + MAX_FUTURE_SECONDS) {
    throw new SignerError('Event created_at is too far in the future')
  }

  const rawTags = raw.tags === undefined ? [] : raw.tags
  if (!Array.isArray(rawTags) || rawTags.length > MAX_TAGS) {
    throw new SignerError('Event tags must be an array')
  }
  const tags: string[][] = rawTags.map((tag) => {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_VALUES) {
      throw new SignerError('Each tag must be an array of strings')
    }
    return tag.map((value) => {
      if (typeof value !== 'string') throw new SignerError('Tag values must be strings')
      return value
    })
  })

  const content = raw.content === undefined ? '' : raw.content
  if (typeof content !== 'string') throw new SignerError('Event content must be a string')
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new SignerError('Event content is too large to sign')
  }

  return { kind, created_at: createdAt, tags, content }
}

export function signTemplate(secret: Uint8Array, template: EventTemplate): Event {
  return finalizeEvent(
    {
      kind: template.kind,
      created_at: template.created_at,
      tags: template.tags,
      content: template.content
    },
    secret
  )
}

function requirePeer(peer: string): string {
  if (!isHexPubkey(peer)) throw new SignerError('Recipient must be a 32-byte hex pubkey')
  return peer.toLowerCase()
}

function requireText(value: unknown, label: string, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SignerError(`${label} must be a non-empty string`)
  }
  if (value.length > max) throw new SignerError(`${label} is too large`)
  return value
}

export function encryptNip04(secret: Uint8Array, peer: string, plaintext: unknown): string {
  return nip04.encrypt(secret, requirePeer(peer), requireText(plaintext, 'Plaintext'))
}

export function decryptNip04(secret: Uint8Array, peer: string, ciphertext: unknown): string {
  try {
    return nip04.decrypt(secret, requirePeer(peer), requireText(ciphertext, 'Ciphertext'))
  } catch (error) {
    throw new SignerError(
      error instanceof SignerError ? error.message : 'Could not decrypt NIP-04 payload'
    )
  }
}

export function encryptNip44(secret: Uint8Array, peer: string, plaintext: unknown): string {
  const conversationKey = nip44.getConversationKey(secret, requirePeer(peer))
  return nip44.encrypt(requireText(plaintext, 'Plaintext'), conversationKey)
}

export function decryptNip44(secret: Uint8Array, peer: string, ciphertext: unknown): string {
  try {
    const conversationKey = nip44.getConversationKey(secret, requirePeer(peer))
    return nip44.decrypt(requireText(ciphertext, 'Ciphertext'), conversationKey)
  } catch (error) {
    throw new SignerError(
      error instanceof SignerError ? error.message : 'Could not decrypt NIP-44 payload'
    )
  }
}
