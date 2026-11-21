import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { sha256Hex, uploadBlob, verifyBlob } from '../src/main/nsite-publish/blossom'

describe('BUD-02 uploads', () => {
  it('uploads with a Nostr authorization and verifies the hash', async () => {
    const stored = new Map<string, Buffer>()
    let authorization = ''
    let declaredHash = ''
    const server = createServer((request, response) => {
      const url = request.url ?? '/'
      if (request.method === 'HEAD' && url.startsWith('/')) {
        const hash = url.slice(1)
        response.writeHead(stored.has(hash) ? 200 : 404).end()
        return
      }
      if (request.method === 'PUT' && url === '/upload') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const body = Buffer.concat(chunks)
          authorization = String(request.headers.authorization ?? '')
          declaredHash = String(request.headers['x-sha-256'] ?? '')
          stored.set(sha256Hex(body), body)
          response.writeHead(200).end()
        })
        return
      }
      if (request.method === 'GET' && url.startsWith('/')) {
        const body = stored.get(url.slice(1))
        if (!body) response.writeHead(404).end()
        else response.writeHead(200).end(body)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const base = `http://127.0.0.1:${port}`
    const bytes = Buffer.from('<!doctype html><h1>Hello</h1>')
    const hash = sha256Hex(bytes)
    const secret = generateSecretKey()

    try {
      const result = await uploadBlob({
        server: base,
        hash,
        bytes,
        path: '/index.html',
        signer: {
          signEvent: async (template) => finalizeEvent(template, secret)
        }
      })
      expect(result).toMatchObject({ server: base, ok: true })
      expect(authorization.startsWith('Nostr ')).toBe(true)
      expect(declaredHash).toBe(hash)
      expect(await verifyBlob(base, hash)).toBe(true)
      expect(await verifyBlob(base, 'b'.repeat(64))).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
