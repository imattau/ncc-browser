import { describe, expect, it } from 'vitest'
import {
  buildNsiteUrl,
  isValidSiteId,
  looksLikeNsiteInput,
  nsiteOrigin,
  parseNsiteAddress
} from '../src/shared/nsite-url'

const PUB = 'npub1rggldfg98xwztqz7emlmvpu0rwfymu23xjyxlkheskern8a2ecfs5ppga9'

describe('nsite:// addresses', () => {
  it('parses a root site with no path', () => {
    expect(parseNsiteAddress(`nsite://${PUB}`)).toMatchObject({ pubkey: PUB, site: null, path: '/' })
    expect(parseNsiteAddress(`nsite://${PUB}/`)).toMatchObject({ site: null, path: '/' })
  })

  it('treats a valid d tag as a named site', () => {
    expect(parseNsiteAddress(`nsite://${PUB}/blog/`)).toMatchObject({ site: 'blog', path: '/' })
    expect(parseNsiteAddress(`nsite://${PUB}/blog`)).toMatchObject({ site: 'blog', path: '/' })
    expect(parseNsiteAddress(`nsite://${PUB}/blog/post.html`)).toMatchObject({
      site: 'blog',
      path: '/post.html'
    })
  })

  it('treats a filename in the first segment as a root-site file', () => {
    expect(parseNsiteAddress(`nsite://${PUB}/index.html`)).toMatchObject({
      site: null,
      path: '/index.html'
    })
    expect(parseNsiteAddress(`nsite://${PUB}/my-post`)).toMatchObject({ site: 'my-post' })
    expect(parseNsiteAddress(`nsite://${PUB}/a/very/long/seg`)).toMatchObject({
      site: 'a',
      path: '/very/long/seg'
    })
  })

  it('normalises traversal and rejects bad hosts', () => {
    // The URL parser collapses `..`, so the result is an ordinary in-site path.
    expect(parseNsiteAddress(`nsite://${PUB}/../etc/passwd`).path).toBe('/passwd')
    expect(() => parseNsiteAddress('nsite://example.com/')).toThrow()
    expect(() => parseNsiteAddress('https://example.com/')).toThrow()
  })

  it('round-trips the canonical form', () => {
    const named = parseNsiteAddress(`nsite://${PUB}/blog/post.html?x=1#top`)
    expect(buildNsiteUrl(named)).toBe(`nsite://${PUB}/blog/post.html?x=1#top`)
    expect(buildNsiteUrl(parseNsiteAddress(`nsite://${PUB}`))).toBe(`nsite://${PUB}/`)
  })

  it('builds signer origins per site', () => {
    expect(nsiteOrigin(PUB, null)).toBe(`nsite://${PUB}`)
    expect(nsiteOrigin(PUB, 'blog')).toBe(`nsite://${PUB}/blog`)
  })

  it('recognises nsite input and valid site ids', () => {
    expect(looksLikeNsiteInput(`nsite://${PUB}`)).toBe(true)
    expect(looksLikeNsiteInput(`ncc://${PUB}`)).toBe(false)
    expect(isValidSiteId('blog')).toBe(true)
    expect(isValidSiteId('my-blog')).toBe(true)
    expect(isValidSiteId('blog-')).toBe(false)
    expect(isValidSiteId('Blog')).toBe(false)
    expect(isValidSiteId('a'.repeat(14))).toBe(false)
  })
})
