/**
 * Relay pool with NCC-05 TLS pinning and per-host Tor routing.
 *
 * Clearnet relays connect directly; an `.onion` relay goes through the active SOCKS
 * proxy when Tor is ready. Both paths share one pool so a mixed relay list works.
 */

import { SimplePool, type Event, type EventTemplate, type Filter } from 'nostr-tools'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { Agent } from 'node:http'
import WebSocket from 'ws'

import { isOnionRelayUrl } from '@shared/relays'
import type { QueryFn } from '../ncc/resolver'
import { createRelayWebSocket, RelayPinStore } from './socket'

export interface RelayPoolOptions {
  pins: RelayPinStore
  /** Current SOCKS proxy, or null when Tor is unavailable. */
  proxy: () => string | null
}

export class RelayPool {
  private pool: SimplePool | null = null
  private agent: SocksProxyAgent | null = null
  private proxy: string | null = null
  private initialized = false
  private readonly known = new Set<string>()

  constructor(private readonly options: RelayPoolOptions) {}

  /** Rebuild the pool if the SOCKS proxy changed. */
  refresh(): void {
    const proxy = this.options.proxy()
    if (this.initialized && proxy === this.proxy) return
    this.closeAll()
    this.initialized = true
    this.proxy = proxy
    this.agent = proxy ? new SocksProxyAgent(proxy) : null
  }

  instance(): SimplePool {
    this.refresh()
    if (!this.pool) {
      const agent = this.agent
      const PinnedWebSocket = createRelayWebSocket({
        pins: this.options.pins,
        agentFor: (url) =>
          agent && isOnionRelayUrl(url) ? (agent as unknown as Agent) : undefined
      })
      this.pool = new SimplePool({
        websocketImplementation: PinnedWebSocket as unknown as typeof WebSocket
      } as never)
    }
    return this.pool
  }

  readonly query: QueryFn = async (relays: string[], filter: Filter): Promise<Event[]> => {
    this.track(relays)
    return this.instance().querySync(relays, filter)
  }

  /**
   * Query with an optional NIP-42 AUTH signer. `querySync` does not expose the
   * callback, so use the EOSE subscription directly when auth may be needed.
   */
  async queryAuth(
    relays: string[],
    filter: Filter,
    onauth?: (event: EventTemplate) => Promise<Event>
  ): Promise<Event[]> {
    this.track(relays)
    if (!onauth) return this.query(relays, filter)
    return (await this.queryAuthReport(relays, filter, onauth)).events
  }

  /**
   * Like `queryAuth`, but also says how many relays actually answered (reached the end
   * of their stored events). Zero means none was reachable, which is different from
   * "reachable and holding nothing": a caller that treats the two alike reports a dead
   * relay as an up-to-date copy.
   */
  async queryAuthReport(
    relays: string[],
    filter: Filter,
    onauth?: (event: EventTemplate) => Promise<Event>
  ): Promise<{ events: Event[]; answered: number }> {
    this.track(relays)
    return new Promise((resolve) => {
      const events: Event[] = []
      let answered = 0
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        resolve({ events, answered })
      }
      const timeout = setTimeout(finish, 6_000)
      timeout.unref?.()
      this.instance().subscribeEose(relays, filter, {
        onevent: (event) => events.push(event),
        onclose: (reasons) => {
          clearTimeout(timeout)
          answered = countAnswered(reasons)
          finish()
        },
        ...(onauth ? { onauth: onauth as never } : {})
      })
    })
  }

  /** Publish to one relay, signing NIP-42 AUTH challenges when needed. */
  publishWithAuth(
    url: string,
    event: Event,
    onauth?: (event: EventTemplate) => Promise<Event>
  ): Promise<string> {
    this.track([url])
    return this.instance().publish([url], event, onauth ? { onauth: onauth as never } : undefined)[0]
  }

  /** Publish to one relay, returning the relay's own acceptance message. */
  publish(url: string, event: Event): Promise<string> {
    this.track([url])
    return this.instance().publish([url], event)[0]
  }

  /** Publish to every relay; fails only when all of them reject. */
  async publishMany(urls: string[], event: Event): Promise<void> {
    this.track(urls)
    const results = await Promise.allSettled(this.instance().publish(urls, event))
    if (results.length > 0 && results.every((result) => result.status === 'rejected')) {
      throw results[0].status === 'rejected' ? results[0].reason : new Error('No relay accepted')
    }
  }

  /** Subscribe on every relay. Used by the NIP-46 transport. */
  subscribeMany(
    urls: string[],
    filters: Filter[],
    params: Parameters<SimplePool['subscribeMany']>[2]
  ): ReturnType<SimplePool['subscribeMany']> {
    this.track(urls)
    return this.instance().subscribeMany(
      urls,
      filters as unknown as Filter,
      params
    )
  }

  waitForNwcResponse(relays: string[], walletPubkey: string, clientPubkey: string, eventId: string, timeoutMs: number): Promise<Event> {
    this.track(relays)
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (error?: Error, event?: Event): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        subscription.close()
        if (error) reject(error)
        else if (event) resolve(event)
      }
      const timeout = setTimeout(() => finish(new Error('NWC wallet did not respond in time')), timeoutMs)
      const subscription = this.instance().subscribeMany(relays, {
        kinds: [23195], authors: [walletPubkey], '#p': [clientPubkey], '#e': [eventId], limit: 1
      }, { onevent: (event) => finish(undefined, event), onclose: () => {
        if (!finished) finish(new Error('NWC relay closed before the wallet responded'))
      } })
    })
  }

  /** Drop live connections for these URLs without touching the rest of the pool. */
  closeUrls(urls: string[]): void {
    if (urls.length === 0 || !this.pool) return
    for (const url of urls) this.known.delete(url)
    this.pool.close(urls)
  }

  closeAll(): void {
    if (this.pool) {
      this.pool.close([...this.known])
      this.pool.close([])
    }
    this.known.clear()
    this.pool = null
    this.agent = null
    this.initialized = false
  }

  private track(urls: string[]): void {
    for (const url of urls) this.known.add(url)
  }
}

/** The close reason nostr-tools reports for a relay that finished sending its events. */
const EOSE_REASON = 'closed automatically on eose'

/** How many relays reached EOSE. Anything else is a connection failure or a refusal. */
export function countAnswered(reasons: unknown): number {
  if (!Array.isArray(reasons)) return 0
  return reasons.filter(
    (entry) =>
      (typeof entry === 'string' ? entry : (entry as { reason?: unknown } | null)?.reason) ===
      EOSE_REASON
  ).length
}
