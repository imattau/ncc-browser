/**
 * Cross-implementation check against a real relay: the Rust build (Android) and this
 * one have to read each other's documents. Opt-in, run by hand:
 *
 *   nak serve --port 10547 &
 *   NCC_SYNC_RELAY=ws://127.0.0.1:10547 NCC_SYNC_NSEC=<hex> NCC_SYNC_PHASE=1 cargo test \
 *     -p ncc-proxy sync::tests::live -- --ignored
 *   NCC_SYNC_RELAY=... NCC_SYNC_NSEC=... vitest run test/sync-live.test.ts
 *   NCC_SYNC_RELAY=... NCC_SYNC_NSEC=... NCC_SYNC_PHASE=2 cargo test \
 *     -p ncc-proxy sync::tests::live -- --ignored
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  nip44,
  type Event,
  type EventTemplate,
  type Filter
} from 'nostr-tools'
import { BookmarkStore } from '../src/main/bookmarks'
import { HistoryStore } from '../src/main/history'
import { SyncPrefsStore } from '../src/main/sync/prefs'
import { SyncService } from '../src/main/sync/service'

const relay = process.env.NCC_SYNC_RELAY
const nsec = process.env.NCC_SYNC_NSEC

describe.skipIf(!relay || !nsec)('desktop sync against a live relay', () => {
  it('reads what the phone published and publishes its own', async () => {
    const sk = Uint8Array.from(Buffer.from(nsec as string, 'hex'))
    const pk = getPublicKey(sk)
    const key = nip44.getConversationKey(sk, pk)
    const provider = {
      getPublicKey: async () => pk,
      signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
      nip44Encrypt: async (_peer: string, plaintext: string) => nip44.encrypt(plaintext, key),
      nip44Decrypt: async (_peer: string, ciphertext: string) => nip44.decrypt(ciphertext, key)
    }
    const pool = new SimplePool()
    const query = (relays: string[], filter: Filter): Promise<Event[]> =>
      pool.querySync(relays, filter)

    const dir = mkdtempSync(join(tmpdir(), 'ncc-sync-live-'))
    const bookmarks = new BookmarkStore(join(dir, 'b.json'))
    const history = new HistoryStore(join(dir, 'h.json'))
    const prefs = new SyncPrefsStore(join(dir, 's.json'))
    prefs.update({ deviceName: 'Desktop' })
    bookmarks.add('https://desktop.example/', 'From the desktop')
    history.record('https://desktop.example/visited', 'Desktop visit')

    const service = new SyncService({
      prefs,
      identity: { provider: () => provider },
      relays: {
        query,
        queryAuth: query,
        publishWithAuth: async (url: string, event: Event) => (await pool.publish([url], event)[0]) ?? 'ok'
      },
      resolveRelays: async () => [relay as string],
      bookmarks,
      history,
      tabs: () => [{ url: 'https://desktop.example/tab', title: 'Desktop tab', lastActive: Date.now() }],
      notify: () => {},
      platform: 'linux'
    })
    const status = await service.configure({
      categories: { bookmarks: true, tabs: true, history: true }
    })
    expect(status.error).toBeNull()

    expect(bookmarks.list().map((entry) => entry.url).sort()).toEqual([
      'https://desktop.example/',
      'https://phone.example/'
    ])
    expect(history.list().map((entry) => entry.url).sort()).toEqual([
      'https://desktop.example/visited',
      'https://phone.example/visited'
    ])
    expect(status.devices.map((device) => [device.name, device.platform])).toEqual([
      ['Phone', 'android']
    ])
    expect(status.devices[0]?.tabs).toEqual([
      { url: 'https://phone.example/tab', title: 'Phone tab' }
    ])
    pool.close([relay as string])
  })
})
