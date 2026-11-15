/**
 * Relay pool with NCC-05 TLS pinning and per-host Tor routing.
 *
 * Clearnet relays connect directly; an `.onion` relay goes through the active SOCKS
 * proxy when Tor is ready. Both paths share one pool so a mixed relay list works.
 */

import { SimplePool, type Event, type Filter } from 'nostr-tools'
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
