import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools'
import { NsitePublishService, type NsiteNetwork } from '../src/main/nsite-publish/service'
import { NsiteStore } from '../src/main/nsite-publish/store'
import {
  NSITE_NAMED_KIND,
  type NsiteSiteFile,
  type PublishedNsite
} from '../src/shared/nsite-publish'

const NOW = 1_800_000_000

function tempFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'ncc-nsite-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><h1>Hello</h1>')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("hi")')
  writeFileSync(join(root, '.hidden'), 'ignore me')
  mkdirSync(join(root, '__MACOSX'))
  writeFileSync(join(root, '__MACOSX', 'junk'), 'ignore me too')
  return root
}

class FakeNetwork implements NsiteNetwork {
  uploads: Array<{ server: string; hash: string; path: string }> = []
  events: Event[] = []
  queryEvents: Event[] = []
  deletionEvents: Event[] = []
  verifyResult = true

  async relaysFor(): Promise<string[]> {
    return ['wss://relay.test']
  }

  async upload(options: {
    server: string
    hash: string
    bytes: Uint8Array
    path: string
  }): Promise<{ server: string; ok: boolean; message: string }> {
    this.uploads.push({ server: options.server, hash: options.hash, path: options.path })
    return { server: options.server, ok: true, message: 'ok' }
  }

  async verify(): Promise<boolean> {
    return this.verifyResult
  }

  async publish(event: Event, relays: string[]): Promise<Array<{ relay: string; ok: boolean; message: string }>> {
    this.events.push(event)
    return relays.map((relay) => ({ relay, ok: true, message: 'ok' }))
  }

  async query(
    _relays: string[],
    filter: { kinds?: number[] }
  ): Promise<Event[]> {
    return filter?.kinds?.includes(5) ? this.deletionEvents : this.queryEvents
  }
}

function setup() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const network = new FakeNetwork()
  let now = NOW
  const store = new NsiteStore(join(mkdtempSync(join(tmpdir(), 'ncc-nsite-store-')), 'sites.json'), () => now)
  const service = new NsitePublishService({
    store,
    identity: {
      provider: () => ({
        getPublicKey: async () => pubkey,
        signEvent: async (template) => finalizeEvent(template, secret)
      }),
      status: () => ({
        configured: true,
        mode: 'local',
        hexPubkey: pubkey,
        source: 'file',
        persisted: true,
        encryptionAvailable: true
      })
    },
    network,
    now: () => now,
    onChange: () => {}
  })
  return {
    service,
    store,
    network,
    secret,
    pubkey,
    advance: (seconds: number) => {
      now += seconds
    }
  }
}

describe('NsitePublishService.scanFolder', () => {
  it('hashes files and skips hidden, macOS and symlink noise', async () => {
    const { service } = setup()
    const scan = await service.scanFolder(tempFolder())
    expect(scan.problems).toEqual([])
    expect(scan.files.map((file) => file.path)).toEqual(['/assets/app.js', '/index.html'])
    expect(scan.totalBytes).toBeGreaterThan(0)
    expect(scan.files.every((file) => /^[0-9a-f]{64}$/.test(file.hash))).toBe(true)
  })

  it('reports a folder with no index.html', async () => {
    const { service } = setup()
    const root = mkdtempSync(join(tmpdir(), 'ncc-nsite-empty-'))
    writeFileSync(join(root, 'app.js'), 'x')
    const scan = await service.scanFolder(root)
    expect(scan.problems.join(' ')).toMatch(/no \/index\.html/)
  })
})

describe('NsiteStore address identity', () => {
  it('replaces a record by owner/siteId when the local id differs', () => {
    const store = new NsiteStore(join(mkdtempSync(join(tmpdir(), 'ncc-nsite-dup-')), 'sites.json'))
    const base: PublishedNsite = {
      id: 'one',
      owner: 'a'.repeat(64),
      siteId: 'blog',
      servers: ['https://blossom.test'],
      files: [{ path: '/index.html', hash: 'b'.repeat(64), size: 0 }],
      manifestEventId: 'c'.repeat(64),
      createdAt: 1,
      updatedAt: 1
    }
    store.upsert(base)
    store.upsert({ ...base, id: 'two', title: 'Newest', updatedAt: 2 })
    const sites = store.state().sites
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({ id: 'one', title: 'Newest', updatedAt: 2 })
  })

  it('keeps the newest duplicate when reading an old index', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ncc-nsite-dup-read-'))
    const file = join(directory, 'sites.json')
    const base: PublishedNsite = {
      id: 'old',
      owner: 'a'.repeat(64),
      siteId: 'blog',
      servers: ['https://blossom.test'],
      files: [{ path: '/index.html', hash: 'b'.repeat(64), size: 0 }],
      manifestEventId: 'c'.repeat(64),
      createdAt: 1,
      updatedAt: 1
    }
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sites: [base, { ...base, id: 'new', title: 'Newest', updatedAt: 5 }]
      })
    )
    const store = new NsiteStore(file)
    expect(store.state().sites).toHaveLength(1)
    expect(store.state().sites[0]).toMatchObject({ id: 'new', title: 'Newest' })
  })
})

describe('NsitePublishService.remove', () => {
  it('publishes a NIP-09 deletion for the manifest and address', async () => {
    const { service, network, store, pubkey } = setup()
    const site: PublishedNsite = {
      id: 'site-1',
      owner: pubkey,
      siteId: 'blog',
      servers: ['https://blossom.test'],
      files: [{ path: '/index.html', hash: 'a'.repeat(64), size: 0 }],
      manifestEventId: 'b'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      lastPublishedAt: NOW
    }
    store.upsert(site)
    const result = await service.remove(site.id)
    expect(result.error).toBeUndefined()
    expect(result.state.sites).toEqual([])
    const deletion = network.events.find((event) => event.kind === 5)
    expect(deletion).toBeDefined()
    expect(deletion?.tags).toEqual(
      expect.arrayContaining([
        ['a', `35128:${pubkey}:blog`],
        ['e', site.manifestEventId],
        ['k', '35128']
      ])
    )
    expect(deletion?.created_at).toBeGreaterThan(NOW)
    expect(store.isHidden(pubkey, 'blog')).toBe(true)
  })

  it('removes locally when the active identity does not own the site', async () => {
    const { service, network, store } = setup()
    store.upsert({
      id: 'site-2',
      owner: 'c'.repeat(64),
      siteId: 'other',
      servers: ['https://blossom.test'],
      files: [{ path: '/index.html', hash: 'a'.repeat(64), size: 0 }],
      manifestEventId: 'd'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW
    })
    const result = await service.remove('site-2')
    expect(result.error).toMatch(/does not own/)
    expect(network.events).toEqual([])
    expect(result.state.sites).toEqual([])
  })
})

describe('NsitePublishService.discover', () => {
  const HASH = 'a'.repeat(64)

  function manifest(
    secret: Uint8Array,
    createdAt: number,
    title: string,
    siteId = 'blog'
  ): Event {
    return finalizeEvent(
      {
        kind: NSITE_NAMED_KIND,
        created_at: createdAt,
        tags: [
          ['d', siteId],
          ['title', title],
          ['path', '/index.html', HASH],
          ['server', 'https://blossom.test']
        ],
        content: ''
      },
      secret
    )
  }

  it('rebuilds sites from the newest manifest and keeps local ids', async () => {
    const { service, network, store, secret, pubkey } = setup()
    network.queryEvents = [
      manifest(secret, NOW, 'Old'),
      manifest(secret, NOW + 10, 'New')
    ]
    const result = await service.discover()
    expect(result.found).toBe(1)
    expect(result.error).toBeUndefined()
    const state = store.state()
    expect(state.sites).toHaveLength(1)
    expect(state.sites[0]).toMatchObject({
      owner: pubkey,
      siteId: 'blog',
      title: 'New',
      servers: ['https://blossom.test'],
      manifestEventId: network.queryEvents[1].id,
      lastPublishedAt: NOW + 10
    })
    expect(state.sites[0].files).toEqual([{ path: '/index.html', hash: HASH, size: 0 }])

    const localId = state.sites[0].id
    network.queryEvents = [manifest(secret, NOW + 20, 'Renamed')]
    await service.discover()
    expect(store.state().sites[0].id).toBe(localId)
    expect(store.state().sites[0].title).toBe('Renamed')
  })

  it('ignores manifests covered by a NIP-09 deletion until a newer one wins', async () => {
    const { service, network, secret, pubkey } = setup()
    const deleted = manifest(secret, NOW + 10, 'Deleted')
    network.queryEvents = [deleted]
    network.deletionEvents = [
      finalizeEvent(
        {
          kind: 5,
          created_at: NOW + 15,
          tags: [
            ['a', `35128:${pubkey}:blog`],
            ['e', deleted.id],
            ['k', '35128']
          ],
          content: ''
        },
        secret
      )
    ]
    expect((await service.discover()).found).toBe(0)

    network.queryEvents = [manifest(secret, NOW + 20, 'Restored')]
    const result = await service.discover()
    expect(result.found).toBe(1)
    expect(service.state().sites[0]?.title).toBe('Restored')
  })

  it('does not resurrect a removed site until it is republished', async () => {
    const { service, network, store, secret } = setup()
    network.queryEvents = [manifest(secret, NOW, 'Blog')]
    await service.discover()
    const site = store.state().sites[0]
    store.remove(site.id)
    expect(store.isHidden(site.owner, site.siteId)).toBe(true)

    const again = await service.discover()
    expect(again.found).toBe(0)
    expect(store.state().sites).toEqual([])

    store.upsert({ ...site, title: 'Republished' })
    expect(store.isHidden(site.owner, site.siteId)).toBe(false)
    expect(store.state().sites[0].title).toBe('Republished')
  })

  it('reports when no identity is configured', async () => {
    const secret = generateSecretKey()
    const network = new FakeNetwork()
    const service = new NsitePublishService({
      store: new NsiteStore(join(mkdtempSync(join(tmpdir(), 'ncc-nsite-noid-')), 'sites.json')),
      identity: {
        provider: () => null,
        status: () => ({ configured: false, mode: 'none', source: 'none', persisted: false, encryptionAvailable: false })
      },
      network
    })
    const result = await service.discover()
    expect(result.error).toMatch(/Connect a Nostr identity/)
    expect(result.found).toBe(0)
    void secret
  })
})

describe('NsitePublishService.publish', () => {
  it('uploads every file to every server, signs and stores the manifest', async () => {
    const { service, store, network, pubkey } = setup()
    const scan = await service.scanFolder(tempFolder())
    const result = await service.publish({
      token: 'token',
      folder: scan.folder,
      files: scan.files,
      siteId: 'my-site',
      title: 'My site',
      description: 'A test',
      source: 'https://example.com',
      servers: ['https://a.example', 'https://b.example'],
      relays: ['wss://relay.test']
    })

    expect(result.address).toContain('/my-site/')
    expect(result.reports).toEqual([{ relay: 'wss://relay.test', ok: true, message: 'ok' }])
    expect(network.uploads).toHaveLength(scan.files.length * 2)
    expect(network.events).toHaveLength(1)
    const manifest = network.events[0]!
    expect(manifest.kind).toBe(NSITE_NAMED_KIND)
    expect(manifest.pubkey).toBe(pubkey)
    expect(verifyEvent(manifest)).toBe(true)
    expect(manifest.tags).toContainEqual(['d', 'my-site'])
    expect(manifest.tags.filter(([name]) => name === 'path')).toHaveLength(scan.files.length)
    expect(manifest.tags.filter(([name]) => name === 'server')).toHaveLength(2)

    const state = store.state()
    expect(state.sites).toHaveLength(1)
    expect(state.sites[0]?.files).toEqual(scan.files)
    expect(state.sites[0]?.owner).toBe(pubkey)
    expect(service.state().sites[0]?.manifestEventId).toBe(manifest.id)
  })

  it('publishes a root site without a d tag', async () => {
    const { service, network } = setup()
    const scan = await service.scanFolder(tempFolder())
    const result = await service.publish({
      token: 'token',
      folder: scan.folder,
      files: scan.files,
      siteId: null,
      title: '',
      description: '',
      source: '',
      servers: ['https://a.example'],
      relays: ['wss://relay.test']
    })
    expect(result.address.endsWith('/')).toBe(true)
    expect(network.events[0]?.tags.some(([name]) => name === 'd')).toBe(false)
  })

  it('bumps created_at on republish and keeps one site entry', async () => {
    const { service, store, network, advance } = setup()
    const scan = await service.scanFolder(tempFolder())
    const input = {
      token: 'token',
      folder: scan.folder,
      files: scan.files,
      siteId: 'my-site',
      title: 'My site',
      description: '',
      source: '',
      servers: ['https://a.example'],
      relays: ['wss://relay.test']
    }
    await service.publish(input)
    const first = network.events[0]!.created_at
    advance(60)
    await service.publish(input)
    const second = network.events[1]!.created_at
    expect(second).toBeGreaterThan(first)
    expect(store.state().sites).toHaveLength(1)
  })

  it('stops between uploads when the job is cancelled', async () => {
    const { service, network } = setup()
    const scan = await service.scanFolder(tempFolder())
    const controller = new AbortController()
    let calls = 0
    network.upload = async (options) => {
      calls += 1
      controller.abort()
      return { server: options.server, ok: true, message: 'ok' }
    }
    await expect(
      service.publish(
        {
          token: 'token',
          folder: scan.folder,
          files: scan.files,
          siteId: 'my-site',
          title: '',
          description: '',
          source: '',
          servers: ['https://a.example'],
          relays: ['wss://relay.test']
        },
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'NsitePublishCancelled' })
    expect(calls).toBe(1)
  })

  it('refuses without an identity or with no server', async () => {
    const { service } = setup()
    const scan = await service.scanFolder(tempFolder())
    await expect(
      service.publish({
        token: 'token',
        folder: scan.folder,
        files: scan.files,
        siteId: 'my-site',
        title: '',
        description: '',
        source: '',
        servers: [],
        relays: []
      })
    ).rejects.toThrow(/Blossom server/)
  })
})

describe('NsitePublishService.verify', () => {
  it('reports files that no server returns', async () => {
    const { service, network } = setup()
    const scan = await service.scanFolder(tempFolder())
    await service.publish({
      token: 'token',
      folder: scan.folder,
      files: scan.files,
      siteId: 'my-site',
      title: '',
      description: '',
      source: '',
      servers: ['https://a.example'],
      relays: ['wss://relay.test']
    })
    const id = service.state().sites[0]!.id
    network.verifyResult = false
    const result = await service.verify(id)
    expect(result.checked).toBe(scan.files.length)
    expect(result.missing).toHaveLength(scan.files.length)
  })
})

describe('NsiteStore', () => {
  it('keeps the index out of the manifest and reloads it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ncc-nsite-store-')), 'sites.json')
    const store = new NsiteStore(file, () => NOW)
    const files: NsiteSiteFile[] = [{ path: '/index.html', hash: 'a'.repeat(64), size: 10 }]
    store.upsert({
      id: 'site-1',
      owner: 'b'.repeat(64),
      siteId: 'my-site',
      title: 'My site',
      servers: ['https://a.example'],
      files,
      manifestEventId: 'c'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW
    })
    const reloaded = new NsiteStore(file, () => NOW)
    expect(reloaded.state().sites[0]?.files).toEqual(files)
    expect(reloaded.findByAddress('b'.repeat(64), 'my-site')?.id).toBe('site-1')
    reloaded.remove('site-1')
    expect(reloaded.state().sites).toEqual([])
  })
})
