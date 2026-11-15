/**
 * TOTP parsing and generation. Runs in the main process only so the shared secret
 * never reaches the chrome renderer or a page.
 */

import { createHmac } from 'node:crypto'

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

export interface TotpConfig {
  secret: Buffer
  algorithm: TotpAlgorithm
  digits: number
  period: number
  label?: string
  issuer?: string
}

export interface TotpCode {
  code: string
  remaining: number
  period: number
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(input: string): Buffer {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
  if (!cleaned) throw new Error('TOTP secret is empty')
  if (!/^[A-Z2-7]+$/.test(cleaned)) throw new Error('TOTP secret is not valid Base32')

  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const character of cleaned) {
    const index = BASE32.indexOf(character)
    if (index === -1) throw new Error('TOTP secret is not valid Base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (bytes.length === 0) throw new Error('TOTP secret is too short')
  return Buffer.from(bytes)
}

/** Accepts a bare Base32 secret or a full otpauth:// URI. */
export function parseTotp(input: string): TotpConfig {
  const value = input.trim()
  if (!value) throw new Error('TOTP secret is empty')

  if (/^otpauth:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('Invalid otpauth URI')
    }
    if (url.hostname.toLowerCase() !== 'totp') {
      throw new Error('Only totp:// otpauth URIs are supported')
    }
    const secret = url.searchParams.get('secret') ?? ''
    if (!secret) throw new Error('otpauth URI has no secret')
    const algorithm = normalizeAlgorithm(url.searchParams.get('algorithm'))
    const digits = normalizeDigits(url.searchParams.get('digits'))
    const period = normalizePeriod(url.searchParams.get('period'))
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || undefined
    return {
      secret: decodeBase32(secret),
      algorithm,
      digits,
      period,
      ...(label ? { label } : {}),
      ...(url.searchParams.get('issuer') ? { issuer: url.searchParams.get('issuer')! } : {})
    }
  }

  return {
    secret: decodeBase32(value),
    algorithm: 'SHA1',
    digits: 6,
    period: 30
  }
}

export function normalizeTotpInput(input: unknown): string {
  if (typeof input !== 'string') return ''
  const value = input.trim()
  if (!value) return ''
  parseTotp(value)
  return value.slice(0, 2048)
}

export function generateTotp(config: TotpConfig, now = Date.now()): TotpCode {
  const seconds = Math.floor(now / 1000)
  const counter = Math.floor(seconds / config.period)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac(config.algorithm.toLowerCase(), config.secret).update(buffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  const code = String(binary % 10 ** config.digits).padStart(config.digits, '0')
  return {
    code,
    remaining: config.period - (seconds % config.period),
    period: config.period
  }
}

export function totpFor(input: string, now = Date.now()): TotpCode {
  return generateTotp(parseTotp(input), now)
}

function normalizeAlgorithm(input: string | null): TotpAlgorithm {
  const value = (input ?? 'SHA1').toUpperCase()
  if (value === 'SHA256' || value === 'SHA512') return value
  return 'SHA1'
}

function normalizeDigits(input: string | null): number {
  const value = Number.parseInt(input ?? '6', 10)
  return value === 8 ? 8 : 6
}

function normalizePeriod(input: string | null): number {
  const value = Number.parseInt(input ?? '30', 10)
  if (!Number.isFinite(value)) return 30
  return Math.min(300, Math.max(10, value))
}
