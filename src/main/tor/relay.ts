/**
 * Nostr relay pool for full Tor tabs. Every WebSocket is opened through the active
 * SOCKS proxy, so relay lookups do not reveal the user's IP or the npub being resolved.
 */

import { SimplePool, type Event, type Filter } from 'nostr-tools'
import { SocksProxyAgent } from 'socks-proxy-agent'
import WebSocket from 'ws'
import type { QueryFn } from '../ncc/resolver'

export class TorRelayPool {
  private pool: SimplePool | null = null
  private agent: SocksProxyAgent | null = null
  private proxy: string | null = null

  setProxy(proxy: string | null): void {
    if (proxy === this.proxy) return
    this.close()
    this.proxy = proxy
    this.agent = proxy ? new SocksProxyAgent(proxy) : null
  }

  readonly query: QueryFn = async (relays: string[], filter: Filter): Promise<Event[]> => {
    if (!this.agent) throw new Error('Tor is not ready')
    if (!this.pool) {
      const agent = this.agent
      class TorWebSocket extends WebSocket {
        constructor(address: string, protocols?: string | string[]) {
          super(address, protocols, { agent })
        }
      }
      this.pool = new SimplePool({
        websocketImplementation: TorWebSocket as unknown as typeof WebSocket
      } as never)
    }
    return this.pool.querySync(relays, filter)
  }

  close(): void {
    this.pool?.close([])
    this.pool = null
    this.agent = null
  }
}
