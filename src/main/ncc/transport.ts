/**
 * Pure transport selection for NCC records that publish both clearnet and onion
 * endpoints. Kept free of Electron and Tor so every rule is unit-testable.
 */

import type { ResolvedEndpoint } from '@shared/types'

export interface TransportSelection {
  /** Endpoints that should be attempted for this request, in priority order. */
  candidates: ResolvedEndpoint[]
  /** The locator publishes at least one usable onion endpoint. */
  onionAvailable: boolean
  /** The locator is onion-only and the caller asked for a direct connection. */
  onionOnly: boolean
}

export function isOnionEndpoint(endpoint: ResolvedEndpoint): boolean {
  return endpoint.family === 'onion'
}

export function hasOnionEndpoint(endpoints: readonly ResolvedEndpoint[]): boolean {
  return endpoints.some(isOnionEndpoint)
}

/**
 * Tor mode uses onion endpoints when they exist. Direct mode never tries an onion
 * endpoint, even if its priority would otherwise win: without Tor it can only fail.
 */
export function selectTransportEndpoints(
  endpoints: readonly ResolvedEndpoint[],
  useTor: boolean
): TransportSelection {
  const onionAvailable = hasOnionEndpoint(endpoints)
  const onion = endpoints.filter(isOnionEndpoint)
  const direct = endpoints.filter((endpoint) => !isOnionEndpoint(endpoint))

  if (useTor && onion.length > 0) {
    return { candidates: onion, onionAvailable, onionOnly: false }
  }
  return {
    candidates: direct,
    onionAvailable,
    onionOnly: onionAvailable && direct.length === 0
  }
}

/**
 * Per-service transport overrides for the address-bar onion toggle. Overrides live
 * for the session; changing the global preference clears them.
 */
export class TransportPolicy {
  private readonly forced = new Set<string>()

  constructor(private readonly preferTor: () => boolean) {}

  useTor(pubkey: string, service: string, onionAvailable: boolean): boolean {
    if (!onionAvailable) return false
    return this.forced.has(TransportPolicy.key(pubkey, service)) || this.preferTor()
  }

  /** Flip the per-service override and return the resulting Tor state. */
  toggle(pubkey: string, service: string, onionAvailable: boolean): boolean {
    if (!onionAvailable) return false
    const key = TransportPolicy.key(pubkey, service)
    if (this.forced.has(key)) this.forced.delete(key)
    else this.forced.add(key)
    return this.useTor(pubkey, service, onionAvailable)
  }

  forcedTor(pubkey: string, service: string): boolean {
    return this.forced.has(TransportPolicy.key(pubkey, service))
  }

  clear(): void {
    this.forced.clear()
  }

  private static key(pubkey: string, service: string): string {
    return `${pubkey.toLowerCase()}:${service}`
  }
}
