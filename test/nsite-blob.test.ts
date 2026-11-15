import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { NsiteBlobs } from '../src/main/nsite/blob'

const bytes = Buffer.from('hello nsite')
const HASH = createHash('sha256').update(bytes).digest('hex')

function response(body: Buffer, type = 'text/plain') {
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } })
}

describe('NsiteBlobs', () => {
  it('fetches, verifies and caches a blob', async () => {
    const fetch = vi.fn(async () => response(bytes))
    const blobs = new NsiteBlobs({ fetch, directory: null })

    const first = await blobs.get(HASH, ['https://blossom.example'], '/hello.txt')
    expect(first).toMatchObject({ ok: true, type: 'text/plain', cached: false })
    const second = await blobs.get(HASH, ['https://blossom.example'], '/hello.txt')
    expect(second).toMatchObject({ ok: true, cached: true })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects bytes that do not match the hash', async () => {
    const blobs = new NsiteBlobs({
      fetch: async () => response(Buffer.from('tampered')),
      directory: null
    })
    await expect(blobs.get(HASH, ['https://blossom.example'])).resolves.toMatchObject({
      ok: false,
      code: 'hash-mismatch'
    })
  })

  it('falls over to the next server and remembers failures', async () => {
    const requests: string[] = []
    const blobs = new NsiteBlobs({
      fetch: async (url) => {
        requests.push(url)
        if (url.startsWith('https://bad.example')) throw new Error('boom')
        return response(bytes)
      },
      directory: null
    })

    const result = await blobs.get(HASH, ['https://bad.example', 'https://good.example'])
    expect(result.ok).toBe(true)
    expect(requests).toEqual([
      `https://bad.example/${HASH}`,
      `https://good.example/${HASH}`
    ])
  })

  it('refuses a blob larger than the cap', async () => {
    const blobs = new NsiteBlobs({
      fetch: async () => response(Buffer.alloc(2048)),
      directory: null,
      maxFileBytes: 1024
    })
    await expect(blobs.get(HASH, ['https://blossom.example'])).resolves.toMatchObject({
      ok: false,
      code: 'too-large'
    })
  })

  it('reports when no server can supply the file', async () => {
    const blobs = new NsiteBlobs({
      fetch: async () => new Response('missing', { status: 404 }),
      directory: null
    })
    await expect(blobs.get(HASH, ['https://blossom.example'])).resolves.toMatchObject({
      ok: false,
      code: 'blob-unavailable'
    })
  })
})
