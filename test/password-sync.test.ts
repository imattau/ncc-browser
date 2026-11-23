import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event,
  type EventTemplate
} from 'nostr-tools'
import { describe, expect, it } from 'vitest'
import { PasswordCache } from '../src/main/passwords/cache'
import { PasswordSync, type PasswordSyncContext } from '../src/main/passwords/sync'
import {
  DEFAULT_PASSWORD_CONFIG,
  PASSWORD_VAULT_D,
  PASSWORD_VAULT_VERSION,
  type PasswordConfig,
  type PasswordVault
} from '../src/shared/passwords'
import type { AppConfig } from '../src/shared/types'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const key = nip44.getConversationKey(sk, pk)
const NOW = 1_700_000_000_000

function provider() {
  return {
    getPublicKey: async () => pk,
    signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
    nip44Encrypt: async (_peer: string, plaintext: string) => nip44.encrypt(plaintext, key),
    nip44Decrypt: async (_peer: string, ciphertext: string) => nip44.decrypt(ciphertext, key)
  }
}

const vault: PasswordVault = {
  v: PASSWORD_VAULT_VERSION,
  updatedAt: NOW,
  entries: [
    {
      id: 'e1',
      origin: 'https://example.com',
      title: 'Example',
      username: 'alice',
      password: 'secret',
      notes: '',
      totp: '',
      createdAt: NOW,
      updatedAt: NOW
    }
  ]
}

function harness(options: { vault?: PasswordVault | null; publish?: () => Promise<string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-passwords-sync-'))
  const cache = new PasswordCache(join(dir, 'passwords.json'))
  const passwords: PasswordConfig = { ...DEFAULT_PASSWORD_CONFIG, useNip65: false }
  let current = options.vault === undefined ? vault : options.vault
  let error: string | null = null
  const published: Event[] = []
  const ctx: PasswordSyncContext = {
    isUnlocked: () => current !== null,
    vault: () => current,
    setVault: (next) => {
      current = next
    },
    pubkey: () => pk,
    setError: (next) => {
      error = next
    },
    now: () => NOW,
    config: {
      get: () => ({ relays: [{ url: 'wss://relay.test' }], passwords } as unknown as AppConfig),
      getRelays: () => ['wss://relay.test']
    } as never,
    relays: {
      query: async () => [],
      queryAuth: async () => [],
      publishWithAuth: async (_url, event) => {
        published.push(event)
        return options.publish ? options.publish() : 'ok'
      }
    },
    cache,
    status: () => ({}) as never,
    sendStatus: () => undefined,
    sendContext: () => undefined
  }
  return {
    sync: new PasswordSync(ctx),
    cache,
    passwords,
    published,
    error: () => error,
    vault: () => current
  }
}

function cachedEvent(): Event {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: 1_600_000_000,
      tags: [['d', PASSWORD_VAULT_D]],
      content: 'ciphertext'
    },
    sk
  )
}

describe('PasswordSync', () => {
  it('adopts the cache watermark and pending flag on unlock', () => {
    const h = harness()
    const event = cachedEvent()
    h.cache.set(pk, { event, pending: true, syncedAt: NOW - 1_000 })

    h.sync.load(pk)

    expect(h.sync.state()).toEqual({
      pending: true,
      syncing: false,
      lastSyncedAt: NOW - 1_000
    })
    expect(h.sync.cachedVault()?.event.id).toBe(event.id)
  })

  it('reports the configured relays until a set is resolved', async () => {
    const h = harness()

    expect(h.sync.relayInfo(h.passwords)).toEqual({
      urls: ['wss://relay.test'],
      source: 'browser'
    })
    await expect(h.sync.relaysFor(pk)).resolves.toEqual(['wss://relay.test'])
    expect(h.sync.relayInfo(h.passwords)).toEqual({
      urls: ['wss://relay.test'],
      source: 'browser'
    })
  })

  it('prefers a dedicated vault relay and trims its trailing slash', () => {
    const h = harness()
    h.passwords.vaultRelay = 'wss://vault.test/'

    expect(h.sync.relayInfo(h.passwords)).toEqual({
      urls: ['wss://vault.test'],
      source: 'dedicated'
    })
  })

  it('publishes a local vault and records the cache watermark when no relay copy exists', async () => {
    const h = harness()

    await h.sync.sync(provider(), true)

    expect(h.published).toHaveLength(1)
    expect(h.sync.state()).toEqual({ pending: false, syncing: false, lastSyncedAt: NOW })
    expect(h.error()).toBeNull()
    expect(h.cache.get(pk)?.event.id).toBe(h.published[0].id)
    expect(h.vault()).toEqual(vault)
  })

  it('marks the vault pending when no relay accepts it', async () => {
    const h = harness({ publish: async () => Promise.reject(new Error('relay down')) })

    await h.sync.sync(provider(), true)

    expect(h.sync.state().pending).toBe(true)
    expect(h.error()).toBe('No relay accepted the vault (1 tried)')
  })
})
