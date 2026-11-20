import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event,
  type EventTemplate,
  type Filter
} from 'nostr-tools'
import { PasswordCache } from '../src/main/passwords/cache'
import { PasswordService } from '../src/main/passwords/service'
import type { AppConfig, PasswordPage } from '../src/shared/types'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_HTTPS_MODE,
  DEFAULT_PASSWORD_CONFIG,
  DEFAULT_TOR_SOCKS
} from '../src/shared/types'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const key = nip44.getConversationKey(sk, pk)

function provider() {
  return {
    getPublicKey: async () => pk,
    signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
    nip44Encrypt: async (_peer: string, plaintext: string) => nip44.encrypt(plaintext, key),
    nip44Decrypt: async (_peer: string, ciphertext: string) => nip44.decrypt(ciphertext, key)
  }
}

type FakeConfig = {
  get(): AppConfig
  getRelays(): string[]
  setPasswordConfig(input: unknown): AppConfig
  addNeverSave(origin: string): AppConfig
  removeNeverSave(origin: string): AppConfig
}

function config(): FakeConfig {
  let value: AppConfig = {
    relays: [{ url: 'wss://relay.test' }],
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
  return {
    get: () => value,
    getRelays: () => value.relays.map((entry) => entry.url),
    setPasswordConfig: (input) => {
      value = { ...value, passwords: { ...value.passwords, ...(input as object) } }
      return value
    },
    addNeverSave: (origin) => {
      value = {
        ...value,
        passwords: {
          ...value.passwords,
          neverSave: [...value.passwords.neverSave, origin]
        }
      }
      return value
    },
    removeNeverSave: (origin) => {
      value = {
        ...value,
        passwords: {
          ...value.passwords,
          neverSave: value.passwords.neverSave.filter((entry) => entry !== origin)
        }
      }
      return value
    }
  }
}

function harness(options: { page?: PasswordPage | null; relayStore?: Map<string, Event> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-passwords-'))
  const relayStore = options.relayStore ?? new Map<string, Event>()
  let page =
    options.page === undefined
      ? {
          tabId: 't1',
          kind: 'normal' as const,
          mode: 'web' as const,
          url: 'https://example.com/login',
          displayUrl: 'https://example.com/login',
          title: 'Example login',
          security: null
        }
      : options.page
  const chrome: Array<{ channel: string; payload: unknown }> = []
  const content: Array<{ tabId: string; channel: string; payload: unknown }> = []
  let publishCount = 0
  const cfg = config()
  const query = async (_relays: string[], filter: Filter): Promise<Event[]> => {
    const d = filter['#d']?.[0]
    const event = d ? relayStore.get(d) : undefined
    return event ? [event] : []
  }
  const relays = {
    query,
    queryAuth: query,
    publishWithAuth: async (_url: string, event: Event): Promise<string> => {
      publishCount += 1
      const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
      if (d) relayStore.set(d, event)
      return 'ok'
    }
  }
  const cache = new PasswordCache(join(dir, 'passwords.json'))
  const service = new PasswordService({
    config: cfg,
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
    relays,
    cache,
    host: {
      activePage: () => page,
      pageForTab: () => page,
      tabIdForContents: (id: number) => (id === 1 ? 't1' : null),
      sendToChrome: (channel: string, payload?: unknown) => {
        chrome.push({ channel, payload })
        return true
      },
      sendToContent: (tabId: string, channel: string, payload: unknown) => {
        content.push({ tabId, channel, payload })
        return true
      }
    },
    clipboard: {
      writeText: () => undefined,
      readText: async () => '',
      clear: () => undefined
    },
    dialogs: {
      open: async () => null,
      save: async () => null
    },
    now: () => 1_700_000_000_000,
    ...options
  } as never)
  return {
    service,
    cfg,
    relayStore,
    chrome,
    content,
    publishCount: () => publishCount,
    setPage: (next: PasswordPage | null) => {
      page = next
    },
    cachePath: join(dir, 'passwords.json')
  }
}

const draft = {
  origin: 'https://example.com',
  title: 'Example',
  username: 'alice',
  password: 'secret',
  notes: '',
  totp: ''
}

describe('PasswordService', () => {
  it('advertises the unlocked empty vault as an available authenticator', async () => {
    const h = harness()
    expect(h.service.isWebauthnAuthenticatorAvailable()).toBe(false)
    await h.service.unlock()
    expect(h.service.isWebauthnAuthenticatorAvailable()).toBe(true)
    expect(h.service.hasWebauthnCredentials()).toBe(false)
  })

  it('offers conditional credentials only for the matching RP and allow-list', async () => {
    const h = harness()
    await h.service.unlock()
    const challenge = Buffer.alloc(32, 9).toString('base64url')
    const created = await h.service.webauthnCreate(
      {
        tabId: 't1', kind: 'normal', mode: 'web', url: 'https://example.com/login',
        displayUrl: 'https://example.com/login', title: 'Example', security: null
      },
      'https://example.com',
      {
        challenge, rp: { id: 'example.com', name: 'Example' },
        user: { id: Buffer.from('user-1').toString('base64url'), name: 'alice@example.com' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required' }
      },
      async () => 0
    )
    expect(created.handled).toBe(true)
    expect(h.service.hasWebauthnCredentials()).toBe(true)
    expect(h.service.hasWebauthnCandidates(null, 'https://example.com', { challenge })).toBe(false)

    const page = {
      tabId: 't1', kind: 'normal' as const, mode: 'web' as const, url: 'https://example.com/login',
      displayUrl: 'https://example.com/login', title: 'Example', security: null
    }
    expect(h.service.hasWebauthnCandidates(page, 'https://example.com', { challenge })).toBe(true)
    expect(h.service.hasWebauthnCredentialsForPage(page, 'https://example.com')).toBe(true)
    expect(h.service.hasWebauthnCredentialsForPage({ ...page, url: 'https://another.example/login' }, 'https://another.example')).toBe(false)
    expect(h.service.hasWebauthnCandidates(page, 'https://example.com', { challenge, rpId: 'other.example' })).toBe(false)
    expect(h.service.hasWebauthnCandidates(page, 'https://example.com', { challenge, allowCredentials: [{ id: 'not-this-credential' }] })).toBe(false)
  })

  it('unlocks, saves and lists an encrypted vault', async () => {
    const h = harness()
    const unlocked = await h.service.unlock()
    expect(unlocked.unlocked).toBe(true)
    const saved = await h.service.saveEntry(draft)
    expect(saved.ok).toBe(true)
    expect(saved.pending).toBeFalsy()
    expect(h.service.list()).toHaveLength(1)
    expect(h.service.reveal(h.service.list()[0].id)).toBe('secret')

    const event = [...h.relayStore.values()][0]
    expect(event.kind).toBe(30078)
    expect(event.content).not.toContain('secret')
    expect(event.tags).toContainEqual(['d', 'ncc-browser/passwords/v1'])
    expect(readFileSync(h.cachePath, 'utf8')).not.toContain('secret')
  })

  it('refuses reads and saves while locked', async () => {
    const h = harness()
    expect(h.service.list()).toEqual([])
    const saved = await h.service.saveEntry(draft)
    expect(saved.ok).toBe(false)
    await h.service.unlock()
    h.service.lock()
    expect(h.service.list()).toEqual([])
    expect(() => h.service.reveal('missing')).toThrow()
  })

  it('recovers a vault from the relay with a fresh cache', async () => {
    const relayStore = new Map<string, Event>()
    const first = harness({ relayStore })
    await first.service.unlock()
    await first.service.saveEntry(draft)

    const second = harness({ relayStore })
    const status = await second.service.unlock()
    expect(status.unlocked).toBe(true)
    expect(second.service.list()).toHaveLength(1)
    expect(second.service.list()[0].title).toBe('Example')
    expect(second.publishCount()).toBe(0)
  })

  it('offers to save a submitted login and stores it after confirmation', async () => {
    const h = harness()
    await h.service.unlock()
    h.service.handleCapture(1, {
      username: 'bob',
      password: 'hunter2',
      title: 'Example',
      formAction: 'https://example.com/login'
    })
    const request = h.chrome
      .filter((entry) => entry.channel === 'ncc:password-save-request')
      .at(-1)?.payload as { id: string; origin: string; username: string; mode: string }
    expect(request.origin).toBe('https://example.com')
    expect(request.username).toBe('bob')
    expect(request.mode).toBe('create')

    const result = await h.service.respondToSave(request.id, 'save')
    expect(result.ok).toBe(true)
    expect(h.service.list().some((entry) => entry.username === 'bob')).toBe(true)
  })

  it('does not offer to save on HTTP pages', async () => {
    const h = harness({
      page: {
        tabId: 't1',
        kind: 'normal',
        mode: 'web',
        url: 'http://example.com/login',
        displayUrl: 'http://example.com/login',
        title: 'Example',
        security: null
      }
    })
    await h.service.unlock()
    h.service.handleCapture(1, { username: 'bob', password: 'hunter2' })
    expect(h.chrome.some((entry) => entry.channel === 'ncc:password-save-request')).toBe(false)
  })

  it('locks when the identity changes', async () => {
    const h = harness()
    await h.service.unlock()
    expect(h.service.status().unlocked).toBe(true)
    h.service.onIdentityChanged()
    expect(h.service.status().unlocked).toBe(false)
  })

  it('returns a TOTP code without exposing the secret', async () => {
    const h = harness()
    await h.service.unlock()
    await h.service.saveEntry({ ...draft, totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })
    const id = h.service.list()[0].id
    const code = h.service.totp(id)
    expect(code.code).toMatch(/^\d{6}$/)
    expect(code.period).toBe(30)
  })

  it('says so when no relay answers, and retries an offline save once one does', async () => {
    const relayStore = new Map<string, Event>()
    let online = false
    const query = async (_relays: string[], filter: Filter): Promise<Event[]> => {
      const d = filter['#d']?.[0]
      const event = d ? relayStore.get(d) : undefined
      return event ? [event] : []
    }
    const relays = {
      query,
      queryAuth: query,
      queryAuthReport: async (relayUrls: string[], filter: Filter) => ({
        events: await query(relayUrls, filter),
        answered: online ? 1 : 0
      }),
      publishWithAuth: async (_url: string, event: Event): Promise<string> => {
        if (!online) throw new Error('offline')
        const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
        if (d) relayStore.set(d, event)
        return 'ok'
      }
    }
    const h = harness({ relays, relayStore } as never)
    const unlocked = await h.service.unlock()
    expect(unlocked.error).toMatch(/No relay answered/)

    const saved = await h.service.saveEntry(draft)
    expect(saved.ok).toBe(true)
    expect(saved.pending).toBe(true)
    expect(relayStore.size).toBe(0)

    online = true
    const synced = await h.service.syncNow()
    expect(synced.error).toBeNull()
    expect(synced.pending).toBe(false)
    expect(relayStore.size).toBe(1)
  })
})
