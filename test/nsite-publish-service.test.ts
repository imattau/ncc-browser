import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools'
import { NsitePublishService, type NsiteNetwork } from '../src/main/nsite-publish/service'
import { NsiteStore } from '../src/main/nsite-publish/store'
import { NSITE_NAMED_KIND, type NsiteSiteFile } from '../src/shared/nsite-publish'

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
