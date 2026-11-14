import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import {
  anchorFallbackRecord,
  anchorInfo,
  applyAnchor,
  parseAnchorEvent,
  selectAnchor
} from '../src/main/ncc/anchor'
import type { ResolvedEndpoint } from '../src/shared/types'

const NOW = 1_800_000_000
const AUTHOR_SK = generateSecretKey()
const AUTHOR_PK = getPublicKey(AUTHOR_SK)
const OTHER_SK = generateSecretKey()
const OTHER_PK = getPublicKey(OTHER_SK)

interface Options {
  d?: string | null
  u?: string | null
  k?: string | null
  exp?: number | null
  createdAt?: number
  kind?: number
  secretKey?: Uint8Array
}

function anchor(options: Options = {}): Event {
  const tags: string[][] = []
  if (options.d !== null) tags.push(['d', options.d ?? 'web'])
  if (options.u) tags.push(['u', options.u])
  if (options.k) tags.push(['k', options.k])
  if (options.exp !== null) tags.push(['exp', String(options.exp ?? NOW + 3600)])
  return finalizeEvent(
    {
      kind: options.kind ?? 30059,
      created_at: options.createdAt ?? NOW - 10,
      tags,
      content: ''
    },
    options.secretKey ?? AUTHOR_SK
  )
}

function endpoint(url: string, k: string | null = null): ResolvedEndpoint {
  return { url, protocol: new URL(url).protocol.slice(0, -1), priority: 1000, family: 'ipv4', k }
}

describe('parseAnchorEvent', () => {
  it('parses the service identity, endpoint and transport key', () => {
    const event = anchor({ d: 'web', u: 'https://10.0.0.2:8443', k: 'SPKI' })
    const parsed = parseAnchorEvent(event, AUTHOR_PK, NOW)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.anchor.dTag).toBe('web')
    expect(parsed.anchor.endpoint).toBe('https://10.0.0.2:8443/')
    expect(parsed.anchor.k).toBe('SPKI')
    expect(parsed.anchor.expiresAt).toBe(NOW + 3600)
  })

  it('keeps a non-web u for display but does not make it fetchable', () => {
    const parsed = parseAnchorEvent(anchor({ u: 'wss://relay.example' }), AUTHOR_PK, NOW)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.anchor.rawEndpoint).toBe('wss://relay.example')
    expect(parsed.anchor.endpoint).toBeNull()
  })

  it('rejects expired, malformed and foreign records', () => {
    const expired = parseAnchorEvent(anchor({ exp: NOW - 1 }), AUTHOR_PK, NOW)
    expect(expired).toEqual({ ok: false, reason: 'expired' })

    const missingD = parseAnchorEvent(anchor({ d: null }), AUTHOR_PK, NOW)
    expect(missingD.ok).toBe(false)

    const invalidExp = parseAnchorEvent(
      finalizeEvent(
        {
          kind: 30059,
          created_at: NOW,
          tags: [['d', 'web'], ['exp', 'soon']],
          content: ''
        },
        AUTHOR_SK
      ),
      AUTHOR_PK,
      NOW
    )
    expect(invalidExp).toEqual({ ok: false, reason: 'invalid' })

    const foreign = parseAnchorEvent(anchor({ secretKey: OTHER_SK }), AUTHOR_PK, NOW)
    expect(foreign.ok).toBe(false)

    const wrongKind = parseAnchorEvent(anchor({ kind: 30058 }), AUTHOR_PK, NOW)
    expect(wrongKind.ok).toBe(false)
  })

  it('accepts a record without exp for compatibility', () => {
    const parsed = parseAnchorEvent(anchor({ exp: null }), AUTHOR_PK, NOW)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.anchor.expiresAt).toBe(0)
  })
})

describe('selectAnchor', () => {
  it('prefers the requested d tag, then the newest event', () => {
    const older = anchor({ d: 'web', createdAt: NOW - 100 })
    const newest = anchor({ d: 'web', createdAt: NOW - 5 })
    const fallback = anchor({ d: 'addr', createdAt: NOW - 1 })
    const selected = selectAnchor([older, fallback, newest], AUTHOR_PK, ['web', 'addr'], NOW)

    expect(selected.status).toBe('anchored')
    if (selected.status !== 'anchored') return
    expect(selected.anchor.eventId).toBe(newest.id)
  })

  it('breaks created_at ties by event id', () => {
    const a = anchor({ d: 'web', createdAt: NOW })
    const b = anchor({ d: 'web', createdAt: NOW })
    const expected = a.id < b.id ? a : b
    const selected = selectAnchor([b, a], AUTHOR_PK, ['web'], NOW)
    expect(selected.status).toBe('anchored')
    if (selected.status !== 'anchored') return
    expect(selected.anchor.eventId).toBe(expected.id)
  })

  it('reports expired and missing anchors distinctly', () => {
    expect(selectAnchor([anchor({ exp: NOW - 1 })], AUTHOR_PK, ['web'], NOW).status).toBe(
      'expired'
    )
    expect(selectAnchor([], AUTHOR_PK, ['web'], NOW).status).toBe('none')
    expect(
      selectAnchor([anchor({ secretKey: OTHER_SK })], AUTHOR_PK, ['web'], NOW).status
    ).toBe('none')
  })

  it('falls through to an older valid record when the newest is invalid', () => {
    const older = anchor({ d: 'web', createdAt: NOW - 100 })
    const newer = anchor({ d: 'web', createdAt: NOW - 1 })
    const broken = finalizeEvent(
      { kind: 30059, created_at: NOW + 10, tags: [['d', 'web']], content: '' },
      AUTHOR_SK
    )
    // Tamper with the tags after signing, so the newest event cannot verify.
    const tampered = { ...broken, tags: [] } as Event
    const selection = selectAnchor([older, newer, tampered], AUTHOR_PK, ['web'], NOW)
    expect(selection.status).toBe('anchored')
    if (selection.status !== 'anchored') return
    expect(selection.anchor.eventId).toBe(newer.id)
  })
})

describe('applyAnchor', () => {
  it('fills a missing locator key from a same-origin NCC-02 key', () => {
    const result = applyAnchor([endpoint('https://host.example:443')], {
      eventId: 'a',
      dTag: 'web',
      endpoint: 'https://host.example/',
      rawEndpoint: 'https://host.example',
      k: 'ANCHOR',
      expiresAt: NOW + 10,
      updatedAt: NOW
    })
    expect(result.conflicts).toBe(0)
    expect(result.kMatch).toBe('anchor-only')
    expect(result.endpoints[0].k).toBe('ANCHOR')
    expect(result.endpoints[0].kSource).toBe('ncc-02')
  })

  it('does not apply a key to a different origin', () => {
    const result = applyAnchor([endpoint('https://other.example:443')], {
      eventId: 'a',
      dTag: 'web',
      endpoint: 'https://host.example/',
      rawEndpoint: 'https://host.example',
      k: 'ANCHOR',
      expiresAt: NOW + 10,
      updatedAt: NOW
    })
    expect(result.kMatch).toBe('none')
    expect(result.endpoints[0].k).toBeNull()
  })

  it('drops an endpoint when the two keys conflict', () => {
    const result = applyAnchor([endpoint('https://host.example:443', 'LOCATOR')], {
      eventId: 'a',
      dTag: 'web',
      endpoint: 'https://host.example/',
      rawEndpoint: 'https://host.example',
      k: 'ANCHOR',
      expiresAt: NOW + 10,
      updatedAt: NOW
    })
    expect(result.endpoints).toHaveLength(0)
    expect(result.conflicts).toBe(1)
    expect(result.kMatch).toBe('mismatch')
  })

  it('applies a private anchor key to endpoints without their own key', () => {
    const result = applyAnchor([endpoint('https://a.example:443'), endpoint('https://b.example:443')], {
      eventId: 'a',
      dTag: 'web',
      endpoint: null,
      rawEndpoint: null,
      k: 'PRIVATE',
      expiresAt: 0,
      updatedAt: NOW
    })
    expect(result.endpoints.map((item) => item.k)).toEqual(['PRIVATE', 'PRIVATE'])
    expect(result.kMatch).toBe('anchor-only')
  })
})

describe('anchorInfo and fallback', () => {
  it('marks the anchor requirement in the info', () => {
    expect(anchorInfo({ status: 'none', anchor: null }, true).status).toBe('required-missing')
    expect(anchorInfo({ status: 'none', anchor: null }, false).status).toBe('unanchored')
  })

  it('synthesises a fallback record from u', () => {
    const info = anchorInfo(
      { status: 'anchored', anchor: anchorRecord() },
      false
    )
    const record = anchorFallbackRecord(
      { pubkey: 'npub', hexPubkey: 'hex', service: 'web' },
      info,
      anchorRecord(),
      NOW,
      120
    )
    expect(record?.endpoints[0].url).toBe('http://10.0.0.9:8080/')
    expect(record?.anchor?.fallback).toBe(true)
    expect(record?.dTag).toBe('web')
  })

  it('does not synthesise a fallback without u', () => {
    const record = anchorRecord({ endpoint: null })
    expect(
      anchorFallbackRecord(
        { pubkey: 'npub', hexPubkey: 'hex', service: 'web' },
        anchorInfo({ status: 'anchored', anchor: record }, false),
        record,
        NOW,
        120
      )
    ).toBeNull()
  })
})

function anchorRecord(overrides: Partial<Parameters<typeof anchorFallbackRecord>[2]> = {}) {
  return {
    eventId: 'event',
    dTag: 'web',
    endpoint: 'http://10.0.0.9:8080',
    rawEndpoint: 'http://10.0.0.9:8080',
    k: null,
    expiresAt: NOW + 600,
    updatedAt: NOW,
    ...overrides
  }
}
