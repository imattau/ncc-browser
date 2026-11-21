/**
 * Opt-in native nsite publish against a real relay and a local Blossom stand-in:
 *
 *   nak serve --port 10547 &
 *   NCC_NSITE_RELAY=ws://127.0.0.1:10547 npx vitest run test/nsite-publish-live.test.ts
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { NsitePublishService, type NsiteNetwork } from '../src/main/nsite-publish/service'
import { NsiteStore } from '../src/main/nsite-publish/store'
import { sha256Hex, uploadBlob, verifyBlob } from '../src/main/nsite-publish/blossom'
import { NSITE_NAMED_KIND } from '../src/shared/nsite-publish'

const relay = process.env.NCC_NSITE_RELAY

describe.skipIf(!relay)('native nsite publish against a live relay', () => {
  it('uploads blobs, publishes the manifest and leaves it queryable', async () => {
    const stored = new Map<string, Buffer>()
    const blossom = createServer((request, response) => {
      const url = request.url ?? '/'
      if (request.method === 'HEAD' && url.startsWith('/')) {
        response.writeHead(stored.has(url.slice(1)) ? 200 : 404).end()
        return
      }
      if (request.method === 'PUT' && url === '/upload') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const body = Buffer.concat(chunks)
          stored.set(sha256Hex(body), body)
          response.writeHead(200).end()
        })
        return
      }
      if (request.method === 'GET' && url.startsWith('/')) {
        const body = stored.get(url.slice(1))
        response.writeHead(body ? 200 : 404).end(body)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => blossom.listen(0, '127.0.0.1', resolve))
    const address = blossom.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const server = `http://127.0.0.1:${port}`

    const folder = mkdtempSync(join(tmpdir(), 'ncc-nsite-live-'))
    writeFileSync(join(folder, 'index.html'), '<!doctype html><h1>Live</h1>')
    mkdirSync(join(folder, 'assets'))
    writeFileSync(join(folder, 'assets', 'app.js'), 'console.log("live")')

    const secret = generateSecretKey()
    const pubkey = getPublicKey(secret)
    const pool = new SimplePool()
    const network: NsiteNetwork = {
      relaysFor: async () => [relay as string],
      upload: uploadBlob,
      verify: verifyBlob,
      publish: async (event, relays) => {
        await pool.publish(relays, event)
        return relays.map((url) => ({ relay: url, ok: true, message: 'accepted' }))
      }
    }
    const store = new NsiteStore(join(mkdtempSync(join(tmpdir(), 'ncc-nsite-live-store-')), 'sites.json'))
    const service = new NsitePublishService({
      store,
      identity: {
        provider: () => ({
          getPublicKey: async () => pubkey,
          signEvent: async (template) => finalizeEvent(template, secret)
        }),
        status: () => ({
          configured: true,
          mode: 'local',
          hexPubkey: pubkey,
          source: 'file',
          persisted: true,
          encryptionAvailable: true
        })
      },
      network
    })

    try {
      const scan = await service.scanFolder(folder)
      const result = await service.publish({
        token: 'live',
        folder,
        files: scan.files,
        siteId: 'live-site',
        title: 'Live site',
        description: '',
        source: '',
        servers: [server],
        relays: [relay as string]
      })
      expect(result.address).toContain('/live-site/')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const events = await pool.querySync([relay as string], {
        kinds: [NSITE_NAMED_KIND],
        authors: [pubkey],
        '#d': ['live-site']
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.tags).toContainEqual(['d', 'live-site'])
      expect(events[0]?.tags.filter(([name]) => name === 'path')).toHaveLength(2)
      for (const file of scan.files) expect(await verifyBlob(server, file.hash)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => blossom.close(() => resolve()))
    }
  }, 30_000)
})
