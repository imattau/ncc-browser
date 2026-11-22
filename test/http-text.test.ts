import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { requestText } from '../src/main/http-text'

const servers: Server[] = []

function serve(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('requestText', () => {
  it('returns status, headers and text', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-test': 'yes' })
      res.end('hello')
    })
    const response = await requestText(`http://127.0.0.1:${port}/`)
    expect(response).toMatchObject({ status: 200, text: 'hello' })
    expect(response.headers['x-test']).toBe('yes')
  })

  it('follows redirects and posts a body', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/target' })
        res.end()
        return
      }
      if (req.url === '/target' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end(`posted:${body}`)
        })
        return
      }
      res.writeHead(404)
      res.end('missing')
    })
    const response = await requestText(`http://127.0.0.1:${port}/redirect`, {
      method: 'POST',
      body: 'payload'
    })
    expect(response.status).toBe(200)
    expect(response.text).toBe('posted:payload')
  })

  it('rejects an oversized response', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(2048))
    })
    await expect(
      requestText(`http://127.0.0.1:${port}/`, { maxBytes: 100 })
    ).rejects.toThrow(/larger than 100 bytes/)
  })

  it('times out a stalled response', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200)
      res.write('partial')
      // never end
    })
    await expect(
      requestText(`http://127.0.0.1:${port}/`, { timeoutMs: 150 })
    ).rejects.toThrow(/timed out/)
  })

  it('rejects unsupported schemes', async () => {
    await expect(requestText('ftp://example.com/')).rejects.toThrow(/http/)
  })

  it('reports a non-2xx status instead of throwing', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(503)
      res.end('down')
    })
    const response = await requestText(`http://127.0.0.1:${port}/`)
    expect(response.status).toBe(503)
    expect(response.text).toBe('down')
  })
})
