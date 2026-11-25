import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
  type EventTemplate,
  type Filter
} from 'nostr-tools'
import { PasswordCache } from '../src/main/passwords/cache'
import { PasswordService } from '../src/main/passwords/service'
import type { AppConfig } from '../src/shared/types'
import type { PasswordPage } from '../src/shared/passwords'
import { DEFAULT_APPEARANCE, DEFAULT_HTTPS_MODE, DEFAULT_TOR_SOCKS } from '../src/shared/types'
import { DEFAULT_PASSWORD_CONFIG } from '../src/shared/passwords'

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
    return (filter['#d'] ?? []).flatMap((d) => relayStore.get(d) ?? [])
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

  it('deletes from a full vault, which frees room for a new login', async () => {
    const h = harness()
    await h.service.unlock()
    const filler = (index: number) => ({ ...draft, username: `user${index}`, notes: 'x'.repeat(4000) })
    let saved = 0
    while ((await h.service.saveEntry(filler(saved))).ok) saved += 1
    expect(saved).toBeGreaterThan(5)

    const removed = await h.service.removeEntry(h.service.list()[0].id)
    expect(removed.ok).toBe(true)
    expect(h.service.list()).toHaveLength(saved - 1)
    expect((await h.service.saveEntry(filler(saved + 1))).ok).toBe(true)
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

  // unlock() itself fires backfillIdentitySecrets() in the background (see below), so
  // these tests unlock with no localIdentitySecrets dep (making that auto-run a no-op),
  // set up vault state deterministically, then inject the dep and call the private
  // method directly — otherwise the auto-run would race the test's own setEntry calls.
  function withInjectedIdentitySecrets(
    h: ReturnType<typeof harness>,
    secrets: Array<{ npub: string; nsec: string }>
  ): Promise<void> {
    ;(h.service as unknown as { deps: { localIdentitySecrets: () => typeof secrets } }).deps.localIdentitySecrets =
      () => secrets
    return (h.service as unknown as { backfillIdentitySecrets(): Promise<void> }).backfillIdentitySecrets()
  }

  it('backfills a "Nostr identity" entry for a local identity that never got one', async () => {
    const alreadySaved = generateSecretKey()
    const missingEntry = generateSecretKey()
    const identity = (sk: Uint8Array) => ({
      npub: nip19.npubEncode(getPublicKey(sk)),
      nsec: nip19.nsecEncode(sk)
    })
    const h = harness()
    await h.service.unlock()
    // One of the two already has an entry (as if saved at generation time); the other
    // predates that code and has none.
    const already = identity(alreadySaved)
    const missing = identity(missingEntry)
    await h.service.saveEntry({
      origin: `ncc://${already.npub}/identity`,
      title: 'Nostr identity',
      username: already.npub,
      password: already.nsec,
      notes: '',
      totp: ''
    })

    await withInjectedIdentitySecrets(h, [already, missing])

    const entries = h.service.list().filter((entry) => entry.title === 'Nostr identity')
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.username).sort()).toEqual([already.npub, missing.npub].sort())
  })

  it('does not backfill an identity entry the user deliberately deleted', async () => {
    const deleted = generateSecretKey()
    const npub = nip19.npubEncode(getPublicKey(deleted))
    const nsec = nip19.nsecEncode(deleted)
    const h = harness()
    await h.service.unlock()
    const saved = await h.service.saveEntry({
      origin: `ncc://${npub}/identity`,
      title: 'Nostr identity',
      username: npub,
      password: nsec,
      notes: '',
      totp: ''
    })
    expect(saved.ok).toBe(true)
    await h.service.removeEntry(h.service.list()[0].id)

    await withInjectedIdentitySecrets(h, [{ npub, nsec }])

    expect(h.service.list().filter((entry) => entry.title === 'Nostr identity')).toHaveLength(0)
  })
})

describe('PasswordService with a vault in two parts', () => {
  const stored = (n: number) => ({
    id: n.toString(16).padStart(16, '0'),
    origin: 'https://example.com',
    title: `Login ${n}`,
    username: `user${n}`,
    password: `secret${n}`,
    notes: '',
    totp: '',
    createdAt: n,
    updatedAt: n
  })
  const SECOND = 'ncc-browser/passwords/v1/1'
  const FIRST = 'ncc-browser/passwords/v1'

  function partEvent(d: string, entries: unknown[]): Event {
    return finalizeEvent(
      {
        kind: 30078,
        created_at: 1_600_000_000,
        tags: [['d', d]],
        content: nip44.encrypt(JSON.stringify({ v: 1, updatedAt: 2, entries, parts: 2 }), key)
      },
      sk
    )
  }

  function twoParts(): Map<string, Event> {
    return new Map([
      [FIRST, partEvent(FIRST, [stored(1)])],
      [SECOND, partEvent(SECOND, [stored(2)])]
    ])
  }

  const read = (store: Map<string, Event>, d: string) =>
    JSON.parse(nip44.decrypt(store.get(d)!.content, key)) as {
      parts: number
      entries: Array<{ username: string; deleted?: boolean }>
    }

  const names = (h: ReturnType<typeof harness>) => h.service.list().map((entry) => entry.username).sort()
  const idOf = (h: ReturnType<typeof harness>, username: string) =>
    h.service.list().find((entry) => entry.username === username)!.id

  it('lists both parts as one vault without republishing either', async () => {
    const h = harness({ relayStore: twoParts() })
    const status = await h.service.unlock()
    expect(status.error).toBeNull()
    expect(names(h)).toEqual(['user1', 'user2'])
    expect(h.publishCount()).toBe(0)
  })

  it('rewrites only the part that holds a deleted entry', async () => {
    const h = harness({ relayStore: twoParts() })
    await h.service.unlock()
    const first = h.relayStore.get(FIRST)!.id

    expect((await h.service.removeEntry(idOf(h, 'user2'))).ok).toBe(true)

    expect(h.publishCount()).toBe(1)
    expect(h.relayStore.get(FIRST)!.id).toBe(first)
    expect(read(h.relayStore, SECOND)).toMatchObject({ parts: 2, entries: [{ deleted: true }] })
    expect(names(h)).toEqual(['user1'])
  })

  it('adds a new login to an existing part and never creates one', async () => {
    const h = harness({ relayStore: twoParts() })
    await h.service.unlock()
    expect((await h.service.saveEntry(draft)).ok).toBe(true)
    expect([...h.relayStore.keys()].sort()).toEqual([FIRST, SECOND])
    expect(read(h.relayStore, FIRST).entries.map((e) => e.username)).toEqual(['user1', 'alice'])
  })

  it('treats a part the relay withholds as unsynced, not deleted or writable', async () => {
    const store = twoParts()
    const second = store.get(SECOND)!
    store.delete(SECOND)
    const h = harness({ relayStore: store })

    await h.service.unlock()
    expect(h.service.status().error).toBe('Some passwords haven’t synced yet')
    expect((await h.service.export('encrypted')).error).toBe('Some passwords haven’t synced yet')
    expect((await h.service.saveEntry(draft)).ok).toBe(true)
    expect(store.has(SECOND)).toBe(false)

    store.set(SECOND, second)
    await h.service.syncNow()
    expect(names(h)).toEqual(['alice', 'user1', 'user2'])
    expect(h.service.status().error).toBeNull()
  })

  it('opens every part from this device when no relay has them', async () => {
    const store = twoParts()
    const first = harness({ relayStore: store })
    await first.service.unlock()
    const cachePath = first.cachePath

    const offline = harness({ cache: new PasswordCache(cachePath) } as never)
    await offline.service.unlock()
    expect(names(offline)).toEqual(['user1', 'user2'])
    // The empty relay gets both parts back, each under its own tag.
    expect([...offline.relayStore.keys()].sort()).toEqual([FIRST, SECOND])
  })

  it('backs up every part and restores them from one file', async () => {
    let file = ''
    const dialogs = {
      open: async () => ({ path: '/backup.json', text: file }),
      save: async (_name: string, data: string) => {
        file = data
        return '/backup.json'
      }
    }
    const source = harness({ relayStore: twoParts(), dialogs } as never)
    await source.service.unlock()
    expect((await source.service.export('encrypted')).ok).toBe(true)
    expect(JSON.parse(file).events).toHaveLength(2)

    const target = harness({ dialogs } as never)
    await target.service.unlock()
    const preview = await target.service.importOpen()
    expect(preview.count).toBe(2)
    expect((await target.service.importCommit(preview.id, 'merge')).ok).toBe(true)
    expect(names(target)).toEqual(['user1', 'user2'])
  })
})
