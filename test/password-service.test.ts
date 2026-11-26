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

  const lastOffer = (h: ReturnType<typeof harness>) =>
    h.chrome.filter((entry) => entry.channel === 'ncc:password-save-request').at(-1)?.payload as {
      id: string
      username: string
      mode: string
    }

  it('keeps a save offer through unlocking, and answers it only once', async () => {
    const h = harness()
    h.service.handleCapture(1, { username: 'bob', password: 'hunter2' })
    const offer = lastOffer(h)

    const first = h.service.respondToSave(offer.id, 'save')
    const second = await h.service.respondToSave(offer.id, 'save')
    expect(second).toEqual({ ok: false, error: 'This login is already being saved' })
    expect((await first).ok).toBe(true)
    expect(h.service.list()).toHaveLength(1)
    expect((await h.service.respondToSave(offer.id, 'save')).error).toBe('That save request expired')
  })

  it('lets a failed save be tried again', async () => {
    const h = harness()
    await h.service.unlock()
    h.service.handleCapture(1, { username: 'bob', password: 'hunter2' })
    const offer = lastOffer(h)
    const save = h.service.saveEntry.bind(h.service)
    h.service.saveEntry = async () => ({ ok: false, error: 'No relay accepted it' })

    expect((await h.service.respondToSave(offer.id, 'save')).error).toBe('No relay accepted it')
    h.service.saveEntry = save
    expect((await h.service.respondToSave(offer.id, 'save')).ok).toBe(true)
    expect(h.service.list()).toHaveLength(1)
  })

  it('uses the account from a username-only step', async () => {
    const h = harness()
    await h.service.unlock()
    h.service.handleUsername(1, { username: 'bob' })
    h.service.handleCapture(1, { username: '', password: 'hunter2' })
    expect(lastOffer(h).username).toBe('bob')
  })

  it('treats a new password with no account as an update to the only login', async () => {
    const h = harness()
    await h.service.unlock()
    await h.service.saveEntry(draft)
    h.service.handleCapture(1, { username: '', password: 'changed' })
    expect(lastOffer(h)).toMatchObject({ username: 'alice', mode: 'update' })
  })

  it('suggests account names beside a field, never passwords', async () => {
    const h = harness()
    h.service.handleFieldFocus(1)
    expect(h.content.at(-1)).toMatchObject({ channel: 'passwords:suggestions', payload: { locked: true, items: [] } })

    await h.service.unlock()
    await h.service.saveEntry(draft)
    h.service.handleFieldFocus(1)
    const sent = h.content.at(-1)!.payload as { locked: boolean; items: Array<{ label: string }> }
    expect(sent.items.map((item) => item.label)).toEqual(['alice'])
    expect(JSON.stringify(sent)).not.toContain('secret')

    const count = h.content.length
    h.service.handleFieldFocus(99)
    expect(h.content).toHaveLength(count)
  })

  it('sends a fill with the page it was matched to', async () => {
    const h = harness()
    await h.service.unlock()
    await h.service.saveEntry(draft)
    const filling = h.service.fill(h.service.list()[0].id)
    const sent = h.content.at(-1)!.payload as { requestId: string; pageUrl: string }
    expect(sent.pageUrl).toBe('https://example.com/login')
    h.service.handleFillResult({ requestId: sent.requestId, ok: true, usernameOnly: true })
    expect(await filling).toEqual({ ok: true, usernameOnly: true })
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

  it('adds a new login to an existing part while there is room', async () => {
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

/** A relay that, like a real one, never replaces an event with an older one. */
function network() {
  const store = new Map<string, Event>()
  const log: string[] = []
  let clock = 1_700_000_000_000
  const tag = (event: Event) => event.tags.find((t) => t[0] === 'd')![1]
  const device = (cachePath?: string) => {
    const state = { online: true, rejects: (_d: string): boolean => false }
    const query = async (_urls: string[], filter: Filter): Promise<Event[]> => {
      if (!state.online) throw new Error('offline')
      return (filter['#d'] ?? []).flatMap((d) => store.get(d) ?? [])
    }
    const path = cachePath ?? join(mkdtempSync(join(tmpdir(), 'ncc-parts-')), 'passwords.json')
    const h = harness({
      cache: new PasswordCache(path),
      now: () => (clock += 1000),
      relays: {
        query,
        queryAuth: query,
        publishWithAuth: async (_url: string, event: Event) => {
          const d = tag(event)
          if (!state.online || state.rejects(d)) throw new Error('rejected')
          const held = store.get(d)
          if (held && held.created_at >= event.created_at) throw new Error('replaced: have newer')
          store.set(d, event)
          log.push(d)
          return 'ok'
        }
      }
    } as never)
    return { ...h, state, path }
  }
  const part = (index: number) => {
    const d = index === 0 ? 'ncc-browser/passwords/v1' : `ncc-browser/passwords/v1/${index}`
    const event = store.get(d)
    if (!event) return null
    const plaintext = nip44.decrypt(event.content, key)
    return {
      bytes: Buffer.byteLength(plaintext),
      ...(JSON.parse(plaintext) as {
        parts?: number
        entries: Array<{ id: string; username: string; notes: string; deleted?: boolean }>
      })
    }
  }
  const usernames = (index: number) =>
    part(index)?.entries.filter((e) => !e.deleted).map((e) => e.username) ?? []
  return { store, log, device, part, usernames }
}

type Device = ReturnType<ReturnType<typeof network>['device']>

const login = (username: string, size: number) => ({ ...draft, username, notes: 'n'.repeat(size) })
const find = (device: Device, username: string) =>
  device.service.list().find((entry) => entry.username === username)!
const notes = (device: Device, username: string) =>
  device.service.entry(find(device, username).id)!.notes.length
const everyone = (device: Device) => device.service.list().map((e) => e.username).sort()
async function resize(device: Device, username: string, size: number) {
  return device.service.saveEntry({ ...login(username, size), id: find(device, username).id })
}

/** Nine large logins: the first part is nearly full. */
async function nearlyFull(device: Device) {
  await device.service.unlock()
  for (let n = 0; n < 9; n += 1) {
    expect((await device.service.saveEntry(login(`big${n}`, 3900))).ok).toBe(true)
  }
  expect((await device.service.saveEntry(login('small', 10))).ok).toBe(true)
}

describe('PasswordService growing into new parts', () => {
  const FIRST = 'ncc-browser/passwords/v1'
  const SECOND = 'ncc-browser/passwords/v1/1'

  it('creates a part when the first is full and records the count in the first', async () => {
    const net = network()
    const a = net.device()
    await a.service.unlock()
    for (let n = 0; n < 24; n += 1) {
      expect((await a.service.saveEntry(login(`user${n}`, 3900))).ok).toBe(true)
    }
    expect(net.store.size).toBeGreaterThanOrEqual(3)
    expect(net.part(0)!.parts).toBe(net.store.size)
    for (let index = 0; index < net.store.size; index += 1) {
      expect(net.part(index)!.bytes).toBeLessThanOrEqual(40_100)
    }
    const fresh = net.device()
    expect((await fresh.service.unlock()).error).toBeNull()
    expect(everyone(fresh)).toEqual(everyone(a))
    expect(everyone(a)).toHaveLength(24)
  })

  it('lets a reader of only the first part know that more exist', async () => {
    const net = network()
    const a = net.device()
    await nearlyFull(a)
    expect((await a.service.saveEntry(login('next', 3900))).ok).toBe(true)
    net.store.delete(SECOND)
    const fresh = net.device()
    expect((await fresh.service.unlock()).error).toBe('Some passwords haven’t synced yet')
    // It must not make parts while it cannot see them all.
    const refused = await fresh.service.saveEntry(login('more', 3900))
    expect(refused.error).toBe('Some passwords haven’t synced yet. Sync before adding more.')
    expect([...net.store.keys()]).toEqual([FIRST])
  })

  it('saves the destination before the source gives up a login that outgrew it', async () => {
    const net = network()
    const a = net.device()
    await nearlyFull(a)
    net.log.length = 0

    expect((await resize(a, 'small', 4000)).ok).toBe(true)

    expect(net.log.indexOf(SECOND)).toBe(0)
    expect(net.log.lastIndexOf(FIRST)).toBeGreaterThan(0)
    expect(net.usernames(0)).not.toContain('small')
    expect(net.usernames(1)).toEqual(['small'])
    expect(notes(a, 'small')).toBe(4000)
  })

  it('keeps the old copy until the destination is accepted, even across a restart', async () => {
    const net = network()
    const a = net.device()
    await nearlyFull(a)
    a.state.rejects = (d) => d === SECOND

    const saved = await resize(a, 'small', 4000)

    expect(saved).toMatchObject({ ok: true, pending: true })
    expect(net.usernames(0)).toContain('small')
    expect(notes(a, 'small')).toBe(4000)
    await a.service.syncNow()
    expect(net.usernames(0)).toContain('small')

    const restarted = net.device(a.path)
    await restarted.service.unlock()
    expect(notes(restarted, 'small')).toBe(4000)
    await restarted.service.syncNow()
    expect(net.usernames(0)).not.toContain('small')
    expect(net.usernames(1)).toEqual(['small'])
    expect(notes(restarted, 'small')).toBe(4000)
  })

  it('does not let a device with the old layout put a moved login back', async () => {
    const net = network()
    const a = net.device()
    await nearlyFull(a)
    const b = net.device()
    await b.service.unlock()

    await resize(a, 'small', 4000)
    // Shrunk again, it would fit where it was, so only the move itself keeps it out.
    await resize(a, 'small', 20)
    await b.service.syncNow()
    net.log.length = 0
    await a.service.syncNow()
    await b.service.syncNow()

    expect(net.log).toEqual([])
    expect(net.usernames(0)).not.toContain('small')
    expect(notes(b, 'small')).toBe(20)
  })

  it('restores logins another device overwrote, spilling into a new part', async () => {
    const net = network()
    const a = net.device()
    await nearlyFull(a)
    const b = net.device()
    await b.service.unlock()
    a.state.online = false
    await a.service.saveEntry(login('from-a', 1500))
    await b.service.saveEntry(login('from-b', 1500))

    a.state.online = true
    for (let round = 0; round < 3; round += 1) {
      await a.service.syncNow()
      await b.service.syncNow()
    }

    expect(everyone(a)).toEqual(everyone(b))
    expect(everyone(a)).toEqual(expect.arrayContaining(['from-a', 'from-b']))
    expect(net.part(0)!.bytes).toBeLessThanOrEqual(40_100)
  })

  it('imports more than one part can hold', async () => {
    const rows = Array.from({ length: 30 }, (_, n) => `site,https://example.com,row${n},pw,${'n'.repeat(3000)},`)
    const text = ['name,url,username,password,notes,totp', ...rows].join('\n')
    const h = harness({
      dialogs: { open: async () => ({ path: '/in.csv', text }), save: async () => null }
    } as never)
    await h.service.unlock()
    const preview = await h.service.importOpen()
    expect((await h.service.importCommit(preview.id, 'merge')).ok).toBe(true)
    expect(h.service.list()).toHaveLength(30)
    expect(h.relayStore.size).toBeGreaterThanOrEqual(3)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'converges without losing anything after random offline edits (seed %i)',
    async (seed) => {
      let state = seed * 2654435761
      const random = (below: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return Math.floor((state / 2 ** 32) * below)
      }
      const net = network()
      const devices = [net.device(), net.device()]
      for (const device of devices) await device.service.unlock()
      /** What each login should end up as: its notes length, or null once deleted. */
      const expected = new Map<string, number | null>()
      let created = 0

      for (let step = 0; step < 70; step += 1) {
        const device = devices[random(2)]
        device.state.online = random(4) > 0
        const blocked = random(5) === 0 ? random(3) : -1
        device.state.rejects = (d) => d === (blocked === 0 ? FIRST : `${FIRST}/${blocked}`)
        const known = everyone(device)
        const action = random(10)
        if (action < 4 || known.length === 0) {
          const name = `login${created++}`
          const size = 200 + random(3800)
          if ((await device.service.saveEntry(login(name, size))).ok) expected.set(name, size)
        } else if (action < 7) {
          const name = known[random(known.length)]
          const size = 200 + random(3800)
          if ((await resize(device, name, size)).ok) expected.set(name, size)
        } else if (action < 8) {
          const name = known[random(known.length)]
          if ((await device.service.removeEntry(find(device, name).id)).ok) expected.set(name, null)
        } else {
          await device.service.syncNow()
        }
      }

      for (const device of devices) {
        device.state.online = true
        device.state.rejects = () => false
      }
      for (let round = 0; round < 5; round += 1) {
        for (const device of devices) await device.service.syncNow()
      }
      net.log.length = 0
      for (const device of devices) await device.service.syncNow()
      expect(net.log).toEqual([])

      const fresh = net.device()
      await fresh.service.unlock()
      const live = [...expected].filter(([, size]) => size !== null).map(([name]) => name).sort()
      for (const device of [...devices, fresh]) {
        // A delete wins over any older edit, so nothing deleted returns.
        expect(everyone(device)).toEqual(live)
        for (const name of live) expect(notes(device, name)).toBe(expected.get(name))
      }
    },
    60_000
  )
})
