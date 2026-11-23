import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAgentProfile, type AgentProfileQuery } from '../src/main/automation/agent-profile'

const secret = generateSecretKey()
const pubkey = getPublicKey(secret)

function profileEvent(content: Record<string, unknown>, created_at: number): Event {
  return finalizeEvent({ kind: 0, created_at, tags: [], content: JSON.stringify(content) }, secret)
}

function manifestEvent(kind: 15128 | 35128, created_at: number, d?: string): Event {
  return finalizeEvent(
    { kind, created_at, tags: d ? [['d', d]] : [], content: '' },
    secret
  )
}

function queryReturning(events: Event[]): AgentProfileQuery {
  return async () => events
}

describe('fetchAgentProfile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns nothing when no relays are configured', async () => {
    const result = await fetchAgentProfile(queryReturning([profileEvent({ name: 'A' }, 1)]), [], pubkey)
    expect(result).toEqual({ profile: null, nsiteAddress: null })
  })

  it('picks the newest kind-0 profile over an older one', async () => {
    const older = profileEvent({ name: 'Old' }, 100)
    const newer = profileEvent({ name: 'New' }, 200)
    const result = await fetchAgentProfile(queryReturning([older, newer]), ['wss://relay'], pubkey)
    expect(result.profile).toEqual({ name: 'New' })
  })

  it('ignores an event whose signature does not verify', async () => {
    const valid = profileEvent({ name: 'Real' }, 100)
    // Round-trip through JSON so the tampered copy loses finalizeEvent's internal
    // "already verified" symbol — otherwise verifyEvent would trust it unchecked.
    const tampered: Event = JSON.parse(JSON.stringify(valid))
    tampered.sig = `00${tampered.sig.slice(2)}`
    const result = await fetchAgentProfile(queryReturning([tampered]), ['wss://relay'], pubkey)
    expect(result.profile).toBeNull()
  })

  it('accepts an https picture and rejects an http one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png', 'content-length': '4' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
      }))
    )
    const httpsResult = await fetchAgentProfile(
      queryReturning([profileEvent({ name: 'A', picture: 'https://example.com/a.png' }, 1)]),
      ['wss://relay'],
      pubkey
    )
    expect(httpsResult.profile?.pictureDataUrl).toMatch(/^data:image\/png;base64,/)

    const httpResult = await fetchAgentProfile(
      queryReturning([profileEvent({ name: 'A', picture: 'http://example.com/a.png' }, 1)]),
      ['wss://relay'],
      pubkey
    )
    expect(httpResult.profile?.pictureDataUrl).toBeUndefined()
  })

  it('rejects a non-image content-type and an oversized body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer
      }))
    )
    const wrongType = await fetchAgentProfile(
      queryReturning([profileEvent({ picture: 'https://example.com/a' }, 1)]),
      ['wss://relay'],
      pubkey
    )
    expect(wrongType.profile).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png', 'content-length': '2000000' }),
        arrayBuffer: async () => new Uint8Array(2_000_000).buffer
      }))
    )
    const oversized = await fetchAgentProfile(
      queryReturning([profileEvent({ picture: 'https://example.com/a' }, 1)]),
      ['wss://relay'],
      pubkey
    )
    expect(oversized.profile).toBeNull()
  })

  it('builds the nsite address for a root site, a named site, and reports null without one', async () => {
    const root = await fetchAgentProfile(queryReturning([manifestEvent(15128, 1)]), ['wss://relay'], pubkey)
    expect(root.nsiteAddress).toBe(`nsite://${pubkey}/`)

    const named = await fetchAgentProfile(
      queryReturning([manifestEvent(35128, 1, 'blog')]),
      ['wss://relay'],
      pubkey
    )
    expect(named.nsiteAddress).toBe(`nsite://${pubkey}/blog/`)

    const none = await fetchAgentProfile(queryReturning([]), ['wss://relay'], pubkey)
    expect(none.nsiteAddress).toBeNull()
  })
})
