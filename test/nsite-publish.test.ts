import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools'
import {
  buildNsiteManifestTags,
  MAX_NSITE_FILE_BYTES,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  nsiteSiteAddress,
  signNsiteManifest,
  validateNsiteFiles,
  validateNsiteSiteId,
  type NsiteSiteFile
} from '../src/shared/nsite-publish'

const HASH = 'a'.repeat(64)

function file(path: string, size = 10, hash = HASH): NsiteSiteFile {
  return { path, hash, size }
}

function signer() {
  const secret = generateSecretKey()
  return {
    pubkey: getPublicKey(secret),
    signEvent: async (template: { kind: number; created_at: number; tags: string[][]; content: string }) =>
      finalizeEvent(template, secret)
  }
}

describe('nsite site validation', () => {
  it('allows a root site and the 1–13 character named grammar', () => {
    expect(validateNsiteSiteId(null)).toBeNull()
    expect(validateNsiteSiteId('my-site')).toBeNull()
    expect(validateNsiteSiteId('a'.repeat(13))).toBeNull()
    expect(validateNsiteSiteId('has space')).toMatch(/1–13/)
    expect(validateNsiteSiteId('trailing-')).toMatch(/not ending/)
    expect(validateNsiteSiteId('UPPER')).not.toBeNull()
  })

  it('requires an index page, safe paths, unique files and size limits', () => {
    expect(validateNsiteFiles([])).toEqual(['Choose a built site folder first.'])
    expect(validateNsiteFiles([file('/assets/app.js')]).join(' ')).toMatch(/no \/index\.html/)
    expect(validateNsiteFiles([file('/index.html'), file('/../secret')]).join(' ')).toMatch(
      /illegal path segment/
    )
    expect(validateNsiteFiles([file('/index.html'), file('/index.html')]).join(' ')).toMatch(
      /appears twice/
    )
    expect(
      validateNsiteFiles([file('/index.html'), file('/big.bin', MAX_NSITE_FILE_BYTES + 1)]).join(' ')
    ).toMatch(/larger than/)
  })
})

describe('NIP-5A manifests', () => {
  it('builds a named manifest with every path and only normalised servers', () => {
    const tags = buildNsiteManifestTags({
      siteId: 'my-site',
      title: 'My site',
      description: 'A test',
      source: 'https://example.com',
      files: [file('/index.html'), file('/assets/app.js')],
      servers: ['https://blossom.example/', 'ftp://nope.example']
    })
    expect(tags).toContainEqual(['d', 'my-site'])
    expect(tags).toContainEqual(['title', 'My site'])
    expect(tags).toContainEqual(['path', '/index.html', HASH])
    expect(tags).toContainEqual(['server', 'https://blossom.example'])
    expect(tags.filter(([name]) => name === 'server')).toEqual([
      ['server', 'https://blossom.example']
    ])
  })

  it('signs a named manifest and verifies it', async () => {
    const local = signer()
    const event = await signNsiteManifest(
      {
        siteId: 'my-site',
        title: 'My site',
        files: [file('/index.html')],
        servers: ['https://blossom.example']
      },
      local,
      1_800_000_000
    )
    expect(event.kind).toBe(NSITE_NAMED_KIND)
    expect(event.content).toBe('')
    expect(event.created_at).toBe(1_800_000_000)
    expect(verifyEvent(event)).toBe(true)
    expect(event.tags).toContainEqual(['d', 'my-site'])
  })

  it('signs a root manifest without a d tag', async () => {
    const local = signer()
    const event = await signNsiteManifest(
      { siteId: null, files: [file('/index.html')], servers: ['https://blossom.example'] },
      local
    )
    expect(event.kind).toBe(NSITE_ROOT_KIND)
    expect(event.tags.some(([name]) => name === 'd')).toBe(false)
  })

  it('refuses an invalid signature before publishing', async () => {
    const local = signer()
    await expect(
      signNsiteManifest(
        { siteId: 'my-site', files: [file('/index.html')], servers: ['https://blossom.example'] },
        {
          signEvent: async (template) => ({
            ...template,
            id: 'c'.repeat(64),
            pubkey: local.pubkey,
            sig: 'd'.repeat(128)
          })
        }
      )
    ).rejects.toThrow(/invalid manifest signature/)
  })

  it('builds the clean site address for root and named sites', () => {
    const pubkey = getPublicKey(generateSecretKey())
    const npub = nip19.npubEncode(pubkey)
    expect(nsiteSiteAddress(pubkey, 'my-site')).toBe(`nsite://${npub}/my-site/`)
    expect(nsiteSiteAddress(pubkey, null)).toBe(`nsite://${npub}/`)
  })
})
