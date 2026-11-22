/**
 * Opt-in public address lookup.
 *
 * This is the only part of endpoint discovery that contacts a third party. It is
 * disclosed by name in the UI, sends a bare GET with no identity or service
 * metadata, caches for ten minutes and is skipped when Tor is preferred.
 */

import { isIP } from 'node:net'

export const PUBLIC_ADDRESS_PROVIDER = 'https://api64.ipify.org?format=json'

export interface PublicAddress {
  address: string
  family: 'ipv4' | 'ipv6'
  provider: string
  checkedAt: number
}

export interface PublicAddressOptions {
  provider?: string
  ttlMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

export function addressFamily(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address.trim())
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null
}

export function parsePublicAddress(
  body: string,
  provider: string,
  checkedAt: number
): PublicAddress | null {
  let value = body.trim()
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as { ip?: unknown }
      value = typeof parsed.ip === 'string' ? parsed.ip.trim() : ''
    } catch {
      return null
    }
  }
  const family = addressFamily(value)
  if (!family) return null
  return { address: value, family, provider, checkedAt }
}

export class PublicAddressService {
  private cache: { at: number; value: PublicAddress } | null = null
  private readonly provider: string
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(options: PublicAddressOptions = {}) {
    this.provider = options.provider ?? process.env.NCC_PUBLIC_ADDRESS_URL ?? PUBLIC_ADDRESS_PROVIDER
    this.ttlMs = options.ttlMs ?? 10 * 60_000
    this.timeoutMs = options.timeoutMs ?? 6000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
  }

  existing(): PublicAddress | null {
    if (!this.cache) return null
    if (this.now() - this.cache.at >= this.ttlMs) return null
    return this.cache.value
  }

  async lookup(force = false): Promise<PublicAddress> {
    const cached = force ? null : this.existing()
    if (cached) return cached

    const response = await this.fetchImpl(this.provider, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json, text/plain' }
    })
    if (!response.ok) throw new Error(`Public address service returned HTTP ${response.status}`)
    const value = parsePublicAddress(await response.text(), this.provider, this.now())
    if (!value) throw new Error('Public address service returned no address')
    this.cache = { at: this.now(), value }
    return value
  }

  clear(): void {
    this.cache = null
  }
}
