import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type Filter } from 'nostr-tools'
import { npubEncode, neventEncode } from 'nostr-tools/nip19'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  parseReleaseReference,
  readRelease,
  revocationReason,
  selectRelease
} from '../src/shared/extension-release'
import { checkDownloadUrl, isPublicAddress } from '../src/main/extensions/download'
import { ExtensionRegistry } from '../src/main/extensions/registry'
import { ExtensionService } from '../src/main/extensions/runtime'
import { ExtensionStore, unpackExtension } from '../src/main/extensions/store'
import { readNpk } from '../src/main/extensions/tar'

const fixtureDir = join(process.cwd(), 'test/fixtures/signed-extension')
const fixtureNpk = readFileSync(join(fixtureDir, 'signed-fixture.npk'))
const fixtureEvents: Event[] = readFileSync(join(fixtureDir, 'events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixtureRevocation: Event = JSON.parse(
  readFileSync(join(fixtureDir, 'revocation.json'), 'utf8')
)
const fixtureRelease = fixtureEvents.find((event) => event.kind === 9900)!

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-store-'))
  roots.push(dir)
  return dir
}

interface TarFile {
  name: string
  data?: string | Buffer
  type?: string
}

function tar(files: TarFile[]): Buffer {
  const blocks: Buffer[] = []
  for (const file of files) {
    const data = Buffer.from(file.data ?? '')
    const header = Buffer.alloc(512)
    header.write(file.name, 0, 100)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write(file.type ?? '0', 156)
    header.write('ustar  \0', 257)
    header.fill(' ', 148, 156)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}
const npk = (files: TarFile[]): Buffer => zstdCompressSync(tar(files))

/** A publisher that signs releases the way npack does. */
function publisher() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  let clock = 1_700_000_000
  const sign = (kind: number, tags: string[][]): Event =>
    finalizeEvent({ kind, tags, created_at: (clock += 1), content: '' }, secret)

  const release = (
    version: string,
    options: { permissions?: string[]; name?: string; tags?: string[][] } = {}
  ) => {
    const name = options.name ?? 'example'
    const bytes = npk([
      {
        name: '.npack/manifest.json',
        data: JSON.stringify({ publisher: pubkey, name, version, kind: 'navigator-extension' })
      },
      {
        name: 'extension/manifest.json',
        data: JSON.stringify({
          manifest_version: 3,
          name: 'Example',
          version,
          permissions: options.permissions ?? ['storage']
        })
      }
    ])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const artifact = sign(1063, [
      ['m', 'application/zstd'],
      ['x', sha256],
      ['url', `https://files.example.org/${sha256}`]
    ])
    const tags = [
      ['d', `${name}/${version}/any`],
      ['v', '1'],
      ['name', name],
      ['version', version],
      ['os', 'any'],
      ['arch', 'any'],
      ['format', 'npk'],
      ['x', sha256],
      ['artifact', artifact.id],
      ['kind', 'navigator-extension'],
      ...(options.tags ?? [])
    ]
    return { event: sign(9900, tags), artifact, bytes, sha256, tags }
  }

  const revoke = (made: ReturnType<typeof release>, reason = 'broken'): Event => {
    const tag = (key: string) => made.tags.find((item) => item[0] === key)![1]
    return sign(9901, [
      ['v', '1'],
      ['e', made.event.id],
      ['name', tag('name')],
      ['version', tag('version')],
      ['x', made.sha256],
      ['reason', reason]
    ])
  }
  return { pubkey, sign, release, revoke }
}

/** Relays and file hosting in memory. */
function network() {
  const events: Event[] = []
  const files = new Map<string, Buffer>()
  const state = { online: true, revocationsAnswer: true }
  const store = new ExtensionStore({
    userRelays: () => ['wss://relay.example.org'],
    relays: {
      async queryAuthReport(_relays: string[], filter: Filter) {
        const silent = !state.online || (!state.revocationsAnswer && filter.kinds?.[0] === 9901)
        if (silent) return { events: [], answered: 0 }
        const found = events.filter(
          (event) =>
            (!filter.kinds || filter.kinds.includes(event.kind)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter.ids || filter.ids.includes(event.id)) &&
            (filter.until === undefined || event.created_at <= filter.until)
        )
        return { events: found, answered: 1 }
      }
    },
    download: async (url) => {
      const bytes = files.get(url)
      if (!bytes) throw new Error('The download failed with HTTP 404')
      return bytes
    }
  })
  const publish = (made: ReturnType<ReturnType<typeof publisher>['release']>) => {
    events.push(made.event, made.artifact)
    files.set(`https://files.example.org/${made.sha256}`, made.bytes)
    return made
  }
  return { events, files, state, store, publish }
}

function service(store: ExtensionStore) {
  const registry = new ExtensionRegistry(join(root(), 'data'))
  const extensions = new ExtensionService({
    registry,
    store,
    storage: { removeExtension: () => undefined },
    host: { extensionPages: () => [], sendToChrome: () => undefined }
  } as never)
  return { registry, extensions }
}

async function install(
  extensions: ExtensionService,
  reference: string
): Promise<string> {
  const prepared = await extensions.prepareRelease(reference)
  if (!prepared.ok) throw new Error(prepared.error)
  const result = extensions.confirmInstall(prepared.review.token, {
    privateTabs: prepared.review.privateTabs
  })
  return result.extension!.id
}

describe('interoperability with npack', () => {
  it('verifies and unpacks a package that npack packed and published', async () => {
    const net = network()
    net.events.push(...fixtureEvents)
    net.files.set('https://downloads.example.org/signed-fixture.npk', fixtureNpk)

    const lookup = await net.store.find(
      parseReleaseReference(`${npubEncode(fixtureRelease.pubkey)}/signed-fixture`)
    )
    expect(lookup.release.version).toBe('1.2.0')
    expect(lookup.revoked).toBeNull()
    const files = await net.store.fetchFiles(lookup)
    // The long path exercises npack's GNU long-name entries.
    expect(files.map((file) => file.name).sort()).toEqual([
      'content.js',
      `${'long'.repeat(20)}/${'name'.repeat(20)}.txt`,
      'manifest.json'
    ])
  })

  it('honours a revocation that npack signed', () => {
    expect(revocationReason(readRelease(fixtureRelease), [fixtureRevocation])).toBe(
      'Fixture revocation'
    )
  })
})

describe('release verification', () => {
  const signer = publisher()
  const good = signer.release('1.0.0')
  const withTags = (edit: (tags: string[][]) => string[][]) =>
    signer.sign(9900, edit(good.tags.map((tag) => [...tag])))
  const set = (key: string, value: string) => (tags: string[][]) =>
    tags.map((tag) => (tag[0] === key ? [key, value] : tag))

  it('rejects an altered or wrongly signed event', () => {
    expect(readRelease(good.event).version).toBe('1.0.0')
    const altered = { ...good.event, tags: set('x', '0'.repeat(64))(good.event.tags) }
    expect(() => readRelease(altered)).toThrow('signature')
    expect(() => readRelease({ ...good.event, pubkey: publisher().pubkey })).toThrow('signature')
  })

  it.each([
    ['an ordinary package', (tags: string[][]) => tags.filter((tag) => tag[0] !== 'kind')],
    ['another protocol version', set('v', '2')],
    ['a platform package', set('os', 'linux')],
    ['a mismatched coordinate', set('version', '9.9.9')],
    ['a repeated tag', (tags: string[][]) => [...tags, ['x', '1'.repeat(64)]]],
    ['a path-like name', set('name', '../evil')],
    ['dependencies', (tags: string[][]) => [...tags, ['depends', 'libfoo', '>=1']]],
    ['install actions', (tags: string[][]) => [...tags, ['post-install', 'run', 'x.sh']]]
  ])('rejects %s', (_label, edit) => {
    expect(() => readRelease(withTags(edit))).toThrow()
  })

  it('only counts revocations from the publisher', () => {
    const release = readRelease(good.event)
    const stranger = publisher()
    expect(revocationReason(release, [stranger.revoke(good as never)])).toBeNull()
    expect(revocationReason(release, [signer.revoke(good, 'leaked key')])).toBe('leaked key')
  })

  it('picks the highest valid version that is not revoked', () => {
    const old = signer.release('1.9.0')
    const best = signer.release('1.10.0')
    const bad = signer.release('2.0.0')
    const other = publisher().release('3.0.0')
    const events = [old.event, bad.event, best.event, other.event]
    expect(selectRelease(events, [signer.revoke(bad)], signer.pubkey, 'example')?.version).toBe(
      '1.10.0'
    )
  })

  it('orders versions by semantic precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0-beta', '1.0.0', '1.2.0', '1.10.0']
    expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered)
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0)
  })

  it('reads release references', () => {
    const id = good.event.id
    expect(parseReleaseReference(`nostr:${neventEncode({ id, relays: ['wss://r.example.org'] })}`))
      .toEqual({ type: 'event', id, relays: ['wss://r.example.org'] })
    expect(parseReleaseReference(` ${signer.pubkey}/example `)).toMatchObject({ type: 'package' })
    for (const bad of ['', 'example', 'npub1nope/example', `${signer.pubkey}/a/b`]) {
      expect(() => parseReleaseReference(bad)).toThrow()
    }
  })

  it('refuses a package whose contents disagree with the release', () => {
    const release = readRelease(good.event)
    expect(() => unpackExtension(good.bytes, { ...release, version: '1.0.1' })).toThrow('match')
    expect(() => unpackExtension(good.bytes, { ...release, name: 'other' })).toThrow('match')
    expect(() => unpackExtension(good.bytes, { ...release, publisher: publisher().pubkey })).toThrow(
      'match'
    )
  })
})

describe('package archive', () => {
  it.each([
    ['a symlink', [{ name: 'extension/link', type: '2' }]],
    ['a hard link', [{ name: 'extension/link', type: '1' }]],
    ['a device', [{ name: 'extension/dev', type: '3' }]],
    ['traversal', [{ name: 'extension/../../evil', data: 'x' }]],
    ['an absolute path', [{ name: '/etc/evil', data: 'x' }]],
    ['a repeated file', [{ name: 'a', data: '1' }, { name: 'a', data: '2' }]],
    [
      'a traversing long name',
      [{ name: '././@LongLink', type: 'L', data: '../evil\0' }, { name: 'a', data: 'x' }]
    ]
  ])('rejects %s', (_label, files) => {
    expect(() => readNpk(npk(files))).toThrow()
  })

  it('rejects damaged, truncated and non-zstd input', () => {
    const bytes = tar([{ name: 'a', data: 'x'.repeat(2000) }])
    const damaged = Buffer.from(bytes)
    damaged[0] = 0x62
    expect(() => readNpk(zstdCompressSync(damaged))).toThrow('damaged')
    expect(() => readNpk(zstdCompressSync(bytes.subarray(0, 1024)))).toThrow('truncated')
    expect(() => readNpk(Buffer.from('PK not zstd'))).toThrow('zstd')
  })

  it('bounds what a small file may expand to', () => {
    expect(() => readNpk(zstdCompressSync(Buffer.alloc(200 * 1024 * 1024)))).toThrow('size limit')
  })
})

describe('download addresses', () => {
  it('allows only public addresses', () => {
    for (const address of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
    for (const address of [
      '127.0.0.1', '10.0.0.1', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1',
      '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'ff02::1', 'localhost'
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('refuses plain HTTP, credentials and private literals in any spelling', () => {
    for (const url of [
      'http://example.org/a', 'file:///etc/passwd', 'https://user:pw@example.org/a',
      'https://127.0.0.1/a', 'https://2130706433/a', 'https://0x7f.1/a', 'https://[::1]/a'
    ]) {
      expect(() => checkDownloadUrl(url), url).toThrow()
    }
    expect(checkDownloadUrl('https://example.org/a').hostname).toBe('example.org')
  })
})

describe('signed installs', () => {
  it('reviews a signed release, with private tabs off', async () => {
    const net = network()
    const signer = publisher()
    net.publish(signer.release('1.0.0'))
    const { registry, extensions } = service(net.store)
    const prepared = await extensions.prepareRelease(`${signer.pubkey}/example`)
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.review.signed).toEqual({ npub: npubEncode(signer.pubkey), name: 'example' })
    expect(prepared.review.privateTabs).toBe(false)
    expect(registry.state().extensions).toHaveLength(0)
    expect(registry.commit(prepared.review.token).extension?.privateTabs).toBe(false)
  })

  it('refuses a download that does not match the signed hash', async () => {
    const net = network()
    const signer = publisher()
    const made = net.publish(signer.release('1.0.0'))
    net.files.set(`https://files.example.org/${made.sha256}`, signer.release('1.0.1').bytes)
    const result = await service(net.store).extensions.prepareRelease(`${signer.pubkey}/example`)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('signed hash') })
  })

  it('refuses a revoked release named exactly, and says when revocation is unknown', async () => {
    const net = network()
    const signer = publisher()
    const made = net.publish(signer.release('1.0.0'))
    const { extensions } = service(net.store)

    net.state.revocationsAnswer = false
    const unknown = await extensions.prepareRelease(made.event.id)
    expect(unknown.ok && unknown.review.notices.join()).toContain('revocation check')

    net.state.revocationsAnswer = true
    net.events.push(signer.revoke(made, 'unsafe'))
    expect(await extensions.prepareRelease(made.event.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('unsafe')
    })
    expect((await extensions.prepareRelease(`${signer.pubkey}/example`)).ok).toBe(false)
  })

  it('identifies an install by publisher and name', async () => {
    const net = network()
    const first = publisher()
    const second = publisher()
    net.publish(first.release('1.0.0'))
    net.publish(second.release('2.0.0'))
    const { registry, extensions } = service(net.store)
    const a = await install(extensions, `${first.pubkey}/example`)
    const b = await install(extensions, `${second.pubkey}/example`)
    expect(a).not.toBe(b)

    net.publish(first.release('1.1.0'))
    expect(await install(extensions, `${first.pubkey}/example`)).toBe(a)
    expect(registry.state().extensions).toHaveLength(2)
  })

  it('keeps signed and local installs from replacing each other', async () => {
    const net = network()
    const signer = publisher()
    net.publish(signer.release('1.0.0'))
    const { registry, extensions } = service(net.store)
    const signedId = await install(extensions, `${signer.pubkey}/example`)

    // A local folder at the path the signed install displays must stay separate.
    const installed = registry.get(signedId)!
    const local = registry.prepareFolder(installed.installPath, {
      sourcePath: installed.sourcePath
    })
    if (!local.ok) throw new Error(local.error)
    expect(local.review.replaces).toBeNull()
    const localId = registry.commit(local.review.token).extension!.id
    expect(localId).not.toBe(signedId)

    net.publish(signer.release('1.1.0'))
    expect(await install(extensions, `${signer.pubkey}/example`)).toBe(signedId)
    expect(registry.get(localId)?.manifest.version).toBe('1.0.0')
  })

  it('refuses to downgrade', async () => {
    const net = network()
    const signer = publisher()
    const old = net.publish(signer.release('1.0.0'))
    net.publish(signer.release('1.1.0'))
    const { extensions } = service(net.store)
    await install(extensions, `${signer.pubkey}/example`)
    expect(await extensions.prepareRelease(old.event.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('older')
    })
  })

  it('offers only a newer version as an update, and marks its new access', async () => {
    const net = network()
    const signer = publisher()
    const first = net.publish(signer.release('1.0.0'))
    const { registry, extensions } = service(net.store)
    const id = await install(extensions, `${signer.pubkey}/example`)
    writeFileSync(join(registry.get(id)!.installPath, 'storage-local.json'), '{"kept":true}')

    expect(await extensions.checkUpdate(id)).toEqual({
      ok: true,
      review: null,
      message: 'No newer version was found.'
    })
    net.publish(signer.release('1.1.0', { permissions: ['storage', 'tabs'] }))
    const update = await extensions.checkUpdate(id)
    if (!update.ok || !update.review) throw new Error('expected an update')
    expect(update.review.permissions.filter((item) => item.added).map((item) => item.id)).toEqual([
      'tabs'
    ])
    expect(registry.get(id)?.store?.releaseId).toBe(first.event.id)
    extensions.confirmInstall(update.review.token, { privateTabs: false })
    expect(registry.get(id)?.manifest.version).toBe('1.1.0')
    expect(existsSync(join(registry.get(id)!.installPath, 'storage-local.json'))).toBe(true)
  })

  it('flags a revoked install without disabling it, and remembers the flag', async () => {
    const net = network()
    const signer = publisher()
    const made = net.publish(signer.release('1.0.0'))
    const { registry, extensions } = service(net.store)
    const id = await install(extensions, `${signer.pubkey}/example`)
    net.events.push(signer.revoke(made, 'compromised'))

    const result = await extensions.checkUpdate(id)
    expect(result).toMatchObject({ ok: true, review: null })
    expect(registry.state().extensions[0]).toMatchObject({
      enabled: true,
      signed: { revoked: 'compromised' }
    })

    net.state.online = false
    await extensions.checkUpdate(id)
    expect(registry.get(id)?.store?.revoked).toBe('compromised')
  })

  it('finds a revocation even when the installed release event has gone', async () => {
    const net = network()
    const signer = publisher()
    const made = net.publish(signer.release('1.0.0'))
    const { registry, extensions } = service(net.store)
    const id = await install(extensions, made.event.id)
    net.events.splice(0, net.events.length, signer.revoke(made, 'withdrawn'))
    expect(await extensions.checkUpdate(id)).toMatchObject({ ok: true, review: null })
    expect(registry.get(id)?.store?.revoked).toBe('withdrawn')
  })

  it('does not report a release as safe when revocations cannot be checked', async () => {
    const net = network()
    const signer = publisher()
    net.publish(signer.release('1.0.0'))
    const { extensions } = service(net.store)
    const id = await install(extensions, `${signer.pubkey}/example`)
    net.state.revocationsAnswer = false
    expect(await extensions.checkUpdate(id)).toMatchObject({
      message: expect.stringContaining('Could not check')
    })
    net.state.online = false
    expect((await extensions.checkUpdate(id)).ok).toBe(false)
  })

  it('reads past a relay page limit', async () => {
    const signer = publisher()
    const target = signer.release('1.0.0')
    const noise = Array.from({ length: 5 }, () => signer.release('1.0.0', { name: 'noise' }).event)
    const all = [target.event, ...noise]
    const query = vi.fn(async (_relays: string[], filter: Filter) => ({
      // Newest first, two at a time, like a relay that caps its answers.
      events: all
        .filter((event) => filter.kinds?.includes(event.kind))
        .filter((event) => filter.until === undefined || event.created_at <= filter.until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 2),
      answered: 1
    }))
    const store = new ExtensionStore({
      relays: { queryAuthReport: query },
      userRelays: () => [],
      download: async () => Buffer.alloc(0)
    })
    const found = await store.find({ type: 'package', publisher: signer.pubkey, name: 'example' })
    expect(found.release.id).toBe(target.event.id)
  })
})
