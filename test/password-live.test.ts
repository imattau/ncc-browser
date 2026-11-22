/**
 * Cross-implementation check of the password vault against a real relay: the Rust
 * build (Android) and this one must read each other's vault event. Opt-in, by hand;
 * the Rust side's doc comment (`vault::tests::live_round_trip_with_the_desktop_build`)
 * gives the order of the three steps.
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
import { PasswordCache } from '../src/main/passwords/cache'
import { PasswordService } from '../src/main/passwords/service'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_HTTPS_MODE,
  DEFAULT_TOR_SOCKS,
  type AppConfig
} from '../src/shared/types'
import { DEFAULT_PASSWORD_CONFIG } from '../src/shared/passwords'

const relay = process.env.NCC_SYNC_RELAY
const nsec = process.env.NCC_SYNC_NSEC

describe.skipIf(!relay || !nsec)('desktop password vault against a live relay', () => {
  it('reads the phone login and publishes its own', async () => {
    const sk = Uint8Array.from(Buffer.from(nsec as string, 'hex'))
    const pk = getPublicKey(sk)
    const key = nip44.getConversationKey(sk, pk)
    const provider = () => ({
      getPublicKey: async () => pk,
      signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
      nip44Encrypt: async (_peer: string, plaintext: string) => nip44.encrypt(plaintext, key),
      nip44Decrypt: async (_peer: string, ciphertext: string) => nip44.decrypt(ciphertext, key)
    })
    const pool = new SimplePool()
    const query = (relays: string[], filter: Filter): Promise<Event[]> =>
      pool.querySync(relays, filter)
    let value: AppConfig = {
      relays: [{ url: relay as string }],
      gossip: true,
      anchorRequired: false,
      preferTor: false,
      ephemeralSigner: false,
      torMode: 'auto',
      torSocks: DEFAULT_TOR_SOCKS,
      httpsMode: DEFAULT_HTTPS_MODE,
      warnInsecure: false,
      httpExceptions: [],
      searchEngine: 'duckduckgo',
      searchEngineCustom: '',
      useOnionSearch: true,
      appearance: { ...DEFAULT_APPEARANCE },
      passwords: { ...DEFAULT_PASSWORD_CONFIG, useNip65: false }
    }
    const service = new PasswordService({
      config: {
        get: () => value,
        getRelays: () => value.relays.map((entry) => entry.url),
        setPasswordConfig: () => value,
        addNeverSave: () => value,
        removeNeverSave: () => value
      },
      identity: {
        status: () => ({
          configured: true,
          mode: 'local',
          npub: 'npub1test',
          hexPubkey: pk,
          source: 'file',
          persisted: true,
          encryptionAvailable: true
        }),
        provider
      },
      relays: {
        query,
        queryAuth: query,
        publishWithAuth: async (url: string, event: Event) =>
          (await pool.publish([url], event)[0]) ?? 'ok'
      },
      cache: new PasswordCache(join(mkdtempSync(join(tmpdir(), 'ncc-pw-live-')), 'p.json')),
      host: {
        activePage: () => null,
        pageForTab: () => null,
        tabIdForContents: () => null,
        sendToChrome: () => true,
        sendToContent: () => true
      },
      clipboard: { writeText: () => undefined, readText: async () => '', clear: () => undefined },
      dialogs: { open: async () => null, save: async () => null }
    } as never)

    const status = await service.unlock()
    expect(status.unlocked).toBe(true)
    expect(status.error).toBeFalsy()
    const phone = service.list().find((entry) => entry.origin === 'https://phone.example')
    expect(phone?.username).toBe('alice')
    expect(await service.reveal(phone?.id as string)).toBe('phone password with spaces ')

    const saved = await service.saveEntry({
      origin: 'https://desktop.example',
      title: 'Desktop login',
      username: 'bob',
      password: 'desktop-secret',
      notes: '',
      totp: ''
    })
    expect(saved.ok).toBe(true)
    expect(saved.pending).toBeFalsy()
    pool.close([relay as string])
    value = { ...value }
  })
})
