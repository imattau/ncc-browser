/**
 * Minimal NIP-46 transport.
 *
 * `@nostrify/nostrify`'s `NRelay1` builds its socket with `websocket-ts`, which
 * offers no way to inject TLS options — so a locator's `k` cannot be enforced for a
 * NIP-46 relay. `NConnectSigner` only needs `req()` and `event()`, so this adapter
 * provides exactly those over the browser's pinned relay pool.
 *
 * The relay URL list is read on every call, so an NCC-05 locator can rotate the
 * bunker relay without rebuilding the signer.
 */

import type { Event, Filter } from 'nostr-tools'

export type BunkerRelayMessage =
  | ['EVENT', string, Event]
  | ['EOSE', string]
  | ['CLOSED', string, string]

export interface BunkerSubscriptionClose {
  url: string
  reason: string
}

export interface BunkerSubscriptionParams {
  onevent?(event: Event): void
  oneose?(): void
  onclose?(reasons: BunkerSubscriptionClose[]): void
}

export interface BunkerSubscription {
  close(reason?: string): void
}

/** The slice of `RelayPool` the NIP-46 transport needs. */
export interface BunkerRelayPool {
  subscribeMany(
    urls: string[],
    filters: Filter[],
    params: BunkerSubscriptionParams
  ): BunkerSubscription
  publishMany(urls: string[], event: Event): Promise<void>
}

export interface BunkerRelay {
  req(
    filters: Filter[],
    opts?: { signal?: AbortSignal }
  ): AsyncIterable<BunkerRelayMessage>
  event(event: Event, opts?: { signal?: AbortSignal }): Promise<void>
}

export interface BunkerRelayOptions {
  urls: () => string[]
  pool: BunkerRelayPool
}

let counter = 0

export function createBunkerRelay(options: BunkerRelayOptions): BunkerRelay {
  return {
    async *req(filters, opts = {}) {
      const urls = options.urls()
      if (urls.length === 0) throw new Error('No NIP-46 relays are configured')

      const subId = `nip46-${(counter += 1).toString(36)}`
      const queue: BunkerRelayMessage[] = []
      let finished = false
      let notify: (() => void) | null = null
      const wake = (): void => {
        const resolve = notify
        notify = null
        resolve?.()
      }

      const sub = options.pool.subscribeMany(urls, filters, {
        onevent: (event) => {
          queue.push(['EVENT', subId, event])
          wake()
        },
        oneose: () => {
          queue.push(['EOSE', subId])
          wake()
        },
        onclose: (reasons) => {
          queue.push([
            'CLOSED',
            subId,
            reasons.map((entry) => entry.reason).join('; ') || 'closed'
          ])
          finished = true
          wake()
        }
      })

      const onAbort = (): void => {
        finished = true
        sub.close()
        wake()
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        while (true) {
          if (opts.signal?.aborted) throw new Error('NIP-46 relay request aborted')
          if (queue.length === 0) {
            if (finished) break
            await new Promise<void>((resolve) => {
              notify = resolve
            })
            continue
          }
          const message = queue.shift()!
          yield message
          if (message[0] === 'CLOSED') break
        }
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
        sub.close()
      }
    },

    async event(event, opts = {}) {
      const urls = options.urls()
      if (urls.length === 0) throw new Error('No NIP-46 relays are configured')

      const published = options.pool.publishMany(urls, event)
      if (!opts.signal) {
        await published
        return
      }

      let onAbort: (() => void) | null = null
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('NIP-46 relay request aborted'))
        if (opts.signal?.aborted) onAbort()
        else opts.signal?.addEventListener('abort', onAbort, { once: true })
      })

      try {
        await Promise.race([published, aborted])
      } finally {
        if (onAbort) opts.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}
