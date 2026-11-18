import { SimplePool } from 'nostr-tools'
import { NwcClient, parseNwcUri } from '../src/shared/nwc.ts'

const pool = new SimplePool()

export function createMobileNwc(uri) {
  const connection = parseNwcUri(uri)
  const transport = {
    publish: async (relays, event) => {
      const results = await Promise.allSettled(pool.publish(relays, event))
      if (results.every((result) => result.status === 'rejected')) throw new Error('No NWC relay accepted the request')
    },
    waitForResponse: (connection, clientPubkey, eventId, timeoutMs) => new Promise((resolve, reject) => {
      const sub = pool.subscribeMany(connection.relays, { kinds: [23195], authors: [connection.pubkey], '#p': [clientPubkey], '#e': [eventId], limit: 1 }, {
        onevent: (event) => { clearTimeout(timer); sub.close(); resolve(event) }
      })
      const timer = setTimeout(() => { sub.close(); reject(new Error('NWC wallet did not respond in time')) }, timeoutMs)
    })
  }
  return new NwcClient(connection, transport)
}
