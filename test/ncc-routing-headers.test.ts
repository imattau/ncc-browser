import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { upstreamRequestInit } from '../src/main/ncc/routing'

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const PUBKEY = '0'.repeat(64)

describe('upstreamRequestInit', () => {
  it('never adds x-ncc-pubkey/x-ncc-service -- nothing reads them back, and their mere presence forces a CORS preflight on every subresource request', () => {
    const request = new Request(`https://${NPUB}/npanel/`)
    const target = new URL('https://127.0.0.1:1/')
    const init = upstreamRequestInit(request, target, PUBKEY, 'npanel')
    const headers = new Headers(init.headers)

    expect(headers.has('x-ncc-pubkey')).toBe(false)
    expect(headers.has('x-ncc-service')).toBe(false)
  })

  it('passes a page-supplied x-ncc-pubkey/x-ncc-service header straight through unmodified -- nothing downstream trusts these, so there is nothing left to spoof', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        pubkey: request.headers['x-ncc-pubkey'] ?? null,
        service: request.headers['x-ncc-service'] ?? null
      }))
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address() as AddressInfo
      const target = new URL(`http://127.0.0.1:${address.port}/`)
      const request = new Request(`https://${NPUB}/npanel/`, {
        headers: { 'x-ncc-pubkey': 'page-supplied-value', 'x-ncc-service': 'ditto' }
      })

      const response = await fetch(target, upstreamRequestInit(request, target, PUBKEY, 'npanel'))
      expect(await response.json()).toEqual({ pubkey: 'page-supplied-value', service: 'ditto' })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('rewrites an ncc:// origin to the real target origin', () => {
    const request = new Request(`https://${NPUB}/npanel/`, {
      headers: { origin: `ncc://${PUBKEY}` }
    })
    const target = new URL('https://1.43.63.94:8445/')
    const init = upstreamRequestInit(request, target, PUBKEY, 'npanel')
    const headers = new Headers(init.headers)

    expect(headers.get('origin')).toBe(target.origin)
  })

  it('rewrites an ncc:// referer to the real target origin+path', () => {
    const request = new Request(`https://${NPUB}/npanel/`, {
      headers: { referer: `ncc://${PUBKEY}/_/npanel/` }
    })
    const target = new URL('https://1.43.63.94:8445/assets/app.js')
    const init = upstreamRequestInit(request, target, PUBKEY, 'npanel')
    const headers = new Headers(init.headers)

    expect(headers.get('referer')).toBe(`${target.origin}${target.pathname}`)
  })

  it('strips host and content-length -- the upstream fetch sets its own', () => {
    const request = new Request(`https://${NPUB}/npanel/`, {
      headers: { host: `${NPUB}`, 'content-length': '0' }
    })
    const target = new URL('https://1.43.63.94:8445/')
    const init = upstreamRequestInit(request, target, PUBKEY, 'npanel')
    const headers = new Headers(init.headers)

    expect(headers.has('host')).toBe(false)
    expect(headers.has('content-length')).toBe(false)
  })
})
