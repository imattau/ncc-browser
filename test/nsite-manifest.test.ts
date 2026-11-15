import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import {
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  aggregateHash,
  matchPath,
  readManifest
} from '../src/main/nsite/manifest'

const SK = generateSecretKey()
const PUB = getPublicKey(SK)
const HASH_A = createHash('sha256').update('a').digest('hex')
const HASH_B = createHash('sha256').update('b').digest('hex')

function manifestEvent(kind: number, tags: string[][]): Event {
  return finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, SK) as Event
}

const root = (tags: string[][]) => manifestEvent(NSITE_ROOT_KIND, tags)

describe('NIP-5A manifests', () => {
  it('indexes path tags and ignores unusable ones', () => {
    const event = root([
      ['path', '/index.html', HASH_A],
      ['path', '/style.css', HASH_B],
      ['path', 'relative.html', HASH_A],
      ['path', '/bad.html', 'nothex'],
      ['server', 'https://blossom.example/'],
      ['title', 'Example'],
      ['description', 'A test site']
    ])
    const result = readManifest(event, PUB, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.manifest.paths.keys()]).toEqual(['/index.html', '/style.css'])
    expect(result.manifest.servers).toEqual(['https://blossom.example'])
    expect(result.manifest.title).toBe('Example')
    expect(result.manifest.description).toBe('A test site')
  })

  it('rejects a manifest with no usable paths', () => {
    const result = readManifest(root([['title', 'Empty']]), PUB, null)
    expect(result).toMatchObject({ ok: false, code: 'manifest-invalid' })
  })

  it('rejects the wrong author and wrong site id', () => {
    const event = manifestEvent(NSITE_NAMED_KIND, [
      ['d', 'blog'],
      ['path', '/index.html', HASH_A]
    ])
    expect(readManifest(event, PUB, 'other')).toMatchObject({ ok: false })
    expect(readManifest(event, PUB, 'blog').ok).toBe(true)
  })

  it('computes the aggregate from path tags only, order independent', () => {
    const one = aggregateHash(
      new Map([
        ['/index.html', HASH_A],
        ['/style.css', HASH_B]
      ])
    )
    const two = aggregateHash(
      new Map([
        ['/style.css', HASH_B],
        ['/index.html', HASH_A]
      ])
    )
    expect(one).toBe(two)
    expect(one).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves index files, directories and misses', () => {
    const paths = new Map([
      ['/index.html', HASH_A],
      ['/blog/index.html', HASH_B],
      ['/blog/post.html', HASH_A],
      ['/404.html', HASH_B]
    ])

    expect(matchPath(paths, '/')).toEqual({ kind: 'file', path: '/index.html', hash: HASH_A })
    expect(matchPath(paths, '/blog/')).toEqual({
      kind: 'file',
      path: '/blog/index.html',
      hash: HASH_B
    })
    expect(matchPath(paths, '/blog')).toEqual({ kind: 'redirect', location: '/blog/' })
    expect(matchPath(paths, '/blog', '?x=1')).toEqual({ kind: 'redirect', location: '/blog/?x=1' })
    expect(matchPath(paths, '/blog/post.html')).toMatchObject({ kind: 'file' })
    expect(matchPath(paths, '/missing.html')).toEqual({ kind: 'missing' })
    expect(matchPath(paths, '/../etc/passwd')).toEqual({ kind: 'missing' })
  })
})
