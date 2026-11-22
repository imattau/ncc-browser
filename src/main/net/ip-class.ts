/**
 * IPv4/IPv6 classification used by endpoint discovery and the gateway report.
 * Pure address arithmetic; no network access.
 */

import type { WanClass } from '@shared/reachability'

const PRIVATE_V4 = [
  { base: '10.0.0.0', bits: 8 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.168.0.0', bits: 16 }
]

export function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function inV4Range(address: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(address)
  const start = ipv4ToInt(base)
  if (value === null || start === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (start & mask)
}

export function isPrivateIPv4(address: string): boolean {
  return PRIVATE_V4.some((range) => inV4Range(address, range.base, range.bits))
}

export function isCgnatIPv4(address: string): boolean {
  return inV4Range(address, '100.64.0.0', 10)
}

export function isLoopbackIPv4(address: string): boolean {
  return inV4Range(address, '127.0.0.0', 8)
}

export function isLoopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || isLoopbackIPv4(value)
}

export function isLinkLocalIPv6(address: string): boolean {
  const value = address.toLowerCase()
  return value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
}

export function isUniqueLocalIPv6(address: string): boolean {
  const value = address.toLowerCase()
  // fc00::/7
  return value.startsWith('fc') || value.startsWith('fd')
}

/** Global unicast: 2000::/3. Everything else is not a public host address. */
export function isGlobalIPv6(address: string): boolean {
  const value = address.toLowerCase()
  return /^[23]/.test(value) && !isLinkLocalIPv6(value)
}

export function classifyWanAddress(address: string | undefined): WanClass {
  if (!address) return 'unknown'
  const value = address.trim()
  if (!value || value === '0.0.0.0') return 'unknown'
  if (isLoopbackIPv4(value)) return 'loopback'
  if (isCgnatIPv4(value)) return 'cgnat'
  if (isPrivateIPv4(value)) return 'private'
  if (value.startsWith('169.254.')) return 'link-local'
  if (ipv4ToInt(value) !== null) return 'public'
  const first = value.toLowerCase()
  if (first === '::1') return 'loopback'
  if (isLinkLocalIPv6(first)) return 'link-local'
  if (isUniqueLocalIPv6(first)) return 'private'
  return 'public'
}
