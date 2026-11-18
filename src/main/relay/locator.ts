/**
 * NCC-05 relay locators.
 *
 * A relay can be added by identity (`ncc://<npub>/<service>`) instead of a fixed
 * address. Resolution reuses the browser's NCC-05 resolver in relay mode, so the
 * record is authenticated, decrypted when needed, freshness-checked and anchored
 * exactly like a page locator — only the endpoint filter differs (ws/wss, not
 * http/https).
 *
 * Locator lookups need relays themselves. The bootstrap order is: plain configured
 * relays, then the last known address of every identity-resolved relay, then the
 * built-in defaults if neither exists.
 */

import { defaultRelays, isOnionRelayUrl, parseRelayLocator, relayUrls } from '@shared/relays'
import type {
  RelayEntry,
  RelayLocatorOutcome,
  RelayLocatorRef
} from '@shared/types'
import { selectRelayEndpoint, type RelayEndpointSelection } from '../ncc/locator'
import type { NccResolver } from '../ncc/resolver'

export interface RelayLocatorDeps {
  resolver: NccResolver
  /** Current relay entries, used for bootstrap and to detect rotation. */
  entries: () => RelayEntry[]
  /** Whether onion endpoints can actually be reached. */
  torReady: () => boolean
}

export class RelayLocatorService {
  constructor(private readonly deps: RelayLocatorDeps) {}

  /** Relays to query when resolving a locator, avoiding the circular case. */
  lookupRelays(): string[] {
    const torReady = this.deps.torReady()
    const known = relayUrls(this.deps.entries()).filter(
      (url) => torReady || !isOnionRelayUrl(url)
    )
    if (known.length > 0) return [...new Set(known)]
    return defaultRelays()
  }

  async resolve(input: string): Promise<RelayLocatorOutcome> {
    const parsed = parseRelayLocator(input)
    if (!parsed) {
      return { ok: false, code: 'invalid-address', error: 'That is not an ncc:// relay address' }
    }
    return this.resolveLocator(parsed.identity, parsed.pubkey, parsed.service)
  }

  /** Re-resolve an existing locator entry, preserving its identity if it moved. */
  async refresh(entry: RelayEntry): Promise<RelayEntry | null> {
    const locator = entry.locator
    if (!locator) return null

    const parsed = parseRelayLocator(locator.identity)
    if (!parsed) return null

    // This path is the explicit expiry refresh. Drop the relay-mode memoized outcome
    // first so refresh() actually confirms the current NCC-05 and NCC-02 records.
    this.deps.resolver.invalidate(locator.pubkey, locator.service, 'relay')
    const outcome = await this.resolveLocator(parsed.identity, locator.pubkey, locator.service)
    if (!outcome.ok) return null

    return { ...outcome.entry, stale: false }
  }

  private async resolveLocator(
    identity: string,
    pubkey: string,
    service: string
  ): Promise<RelayLocatorOutcome> {
    const outcome = await this.deps.resolver.resolve(identity, service, {
      mode: 'relay',
      relays: this.lookupRelays()
    })

    if (!outcome.ok) {
      return {
        ok: false,
        code: outcome.code,
        error: outcome.message
      }
    }

    const record = outcome.record
    const selection: RelayEndpointSelection = selectRelayEndpoint(record.endpoints, {
      torReady: this.deps.torReady()
    })

    if (!selection.endpoint) {
      if (selection.rejected === 'onion-requires-tor') {
        return {
          ok: false,
          code: 'onion-requires-tor',
          error: 'That relay is onion-only and Tor is not ready'
        }
      }
      if (selection.rejected === 'insecure-endpoint') {
        return {
          ok: false,
          code: 'insecure-endpoint',
          error: 'The locator only publishes cleartext ws:// endpoints'
        }
      }
      return {
        ok: false,
        code: 'no-endpoint',
        error: 'The locator publishes no ws:// or wss:// endpoint'
      }
    }

    const locator: RelayLocatorRef = {
      identity,
      pubkey: record.hexPubkey,
      service,
      dTag: record.dTag,
      expiresAt: record.expiresAt,
      ...(record.anchor?.record?.expiresAt
        ? { serviceExpiresAt: record.anchor.record.expiresAt }
        : {}),
      k: selection.endpoint.k
    }

    return {
      ok: true,
      entry: {
        url: selection.endpoint.url.replace(/\/$/, ''),
        locator
      }
    }
  }
}
