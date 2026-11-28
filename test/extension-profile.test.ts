import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import { publicProfileFromEvents } from '../src/main/extensions/profile'

const secretKey = generateSecretKey()
const pubkey = getPublicKey(secretKey)

function profile(content: string, createdAt = 1) {
  return finalizeEvent({ kind: 0, created_at: createdAt, tags: [], content }, secretKey)
}

function imageResponse(bytes: Uint8Array, type = 'image/png', declaredLength = bytes.byteLength): Response {
  return new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': type, 'content-length': String(declaredLength) } })
}

describe('extension public profiles', () => {
  it('uses the newest verified kind-0 name and bounds its length', async () => {
    const old = profile(JSON.stringify({ name: 'Old' }), 1)
    const latest = profile(JSON.stringify({ display_name: ` ${'N'.repeat(100)} `, name: 'Ignored' }), 2)
    const result = await publicProfileFromEvents([old, latest], pubkey)
    expect(result?.name).toBe('N'.repeat(80))
  })

  it('rejects forged, wrong-author, wrong-kind and malformed events', async () => {
    const valid = profile(JSON.stringify({ name: 'Good' }))
    const forged = { ...valid, content: JSON.stringify({ name: 'Forged' }) }
    const other = finalizeEvent({ kind: 0, created_at: 5, tags: [], content: '{"name":"Other"}' }, generateSecretKey())
    const wrongKind = finalizeEvent({ kind: 1, created_at: 6, tags: [], content: '{"name":"Note"}' }, secretKey)
    expect(await publicProfileFromEvents([forged, other, wrongKind], pubkey)).toBeNull()
    expect(await publicProfileFromEvents([profile('[]')], pubkey)).toBeNull()
  })

  it('loads a bounded HTTPS image as a data URL', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => imageResponse(new Uint8Array([1, 2, 3])))
    const result = await publicProfileFromEvents([profile(JSON.stringify({ name: 'Alice', picture: 'https://images.example/alice.png' }))], pubkey, fetcher)
    expect(result).toEqual({ pubkey, name: 'Alice', pictureDataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' })
  })

  it('keeps the profile name if image fetching fails or the picture URL is unsafe', async () => {
    const failingFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('offline') })
    const unavailable = await publicProfileFromEvents([profile(JSON.stringify({ name: 'Alice', picture: 'https://images.example/alice.png' }))], pubkey, failingFetch)
    const unsafe = await publicProfileFromEvents([profile(JSON.stringify({ name: 'Bob', picture: 'http://images.example/bob.png' }))], pubkey, failingFetch)
    expect(unavailable).toEqual({ pubkey, name: 'Alice' })
    expect(unsafe).toEqual({ pubkey, name: 'Bob' })
    expect(failingFetch).toHaveBeenCalledTimes(1)
  })

  it('does not return unsupported types or images above the byte cap', async () => {
    const svgFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => imageResponse(new Uint8Array([1]), 'image/svg+xml'))
    const largeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => imageResponse(new Uint8Array([1]), 'image/png', 512_001))
    const content = (picture: string) => [profile(JSON.stringify({ name: 'Alice', picture }))]
    expect(await publicProfileFromEvents(content('https://images.example/vector.svg'), pubkey, svgFetch)).toEqual({ pubkey, name: 'Alice' })
    expect(await publicProfileFromEvents(content('https://images.example/large.png'), pubkey, largeFetch)).toEqual({ pubkey, name: 'Alice' })
  })
})
