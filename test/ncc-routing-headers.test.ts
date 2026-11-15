import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { upstreamRequestInit } from '../src/main/ncc/routing'

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'
const PUBKEY = '0'.repeat(64)

describe('NCC routing headers', () => {
  it('routes the resolved npub and service and overwrites page-supplied values', async () => {
    const server = createServer((request, response) => {
      if (request.headers['x-ncc-pubkey'] === PUBKEY
          && request.headers['x-ncc-service'] === 'npanel') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('npanel backend')
        return
      }
      response.writeHead(404)
      response.end('no NCC route')
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address() as AddressInfo
      const target = new URL(`http://127.0.0.1:${address.port}/`)
      const request = new Request(`https://${NPUB}/npanel/`, {
        headers: {
          origin: `ncc://${NPUB}`,
          'x-ncc-pubkey': 'page-spoofed-pubkey',
          'x-ncc-service': 'ditto'
        }
      })

      const response = await fetch(
        target,
        upstreamRequestInit(request, target, PUBKEY, 'npanel')
      )

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('npanel backend')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })
})
