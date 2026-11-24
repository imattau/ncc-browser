import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { TlsProxyManager } from '../src/main/hosting/tls-proxy'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ncc-tls-proxy-')), 'tls-proxies.json')
}

function startHttpBackend(body: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.end(body)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

function fetchOverTls(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

describe('TlsProxyManager', () => {
  it('terminates TLS locally and forwards to the http backend', async () => {
    const backend = await startHttpBackend('hello from backend')
    const manager = new TlsProxyManager({ filePath: tempFile() })
    try {
      const status = await manager.ensure('svc-1', { url: `http://127.0.0.1:${backend.port}` })
      expect(status.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/$/)
      expect(status.pin).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(status.target).toBe(`127.0.0.1:${backend.port}`)

      const response = await fetchOverTls(Number(new URL(status.url).port))
      expect(response).toContain('hello from backend')
    } finally {
      manager.shutdown()
      await backend.close()
    }
  })

  it('reuses the same certificate, pin and port on re-ensure', async () => {
    const backend = await startHttpBackend('ok')
    const filePath = tempFile()
    const manager = new TlsProxyManager({ filePath })
    try {
      const first = await manager.ensure('svc-1', { url: `http://127.0.0.1:${backend.port}` })
      const second = await manager.ensure('svc-1', { url: `http://127.0.0.1:${backend.port}` })
      expect(second.pin).toBe(first.pin)
      expect(second.url).toBe(first.url)
    } finally {
      manager.shutdown()
      await backend.close()
    }
  })

  it('removes the proxy and its record', async () => {
    const backend = await startHttpBackend('ok')
    const manager = new TlsProxyManager({ filePath: tempFile() })
    try {
      const status = await manager.ensure('svc-1', { url: `http://127.0.0.1:${backend.port}` })
      await manager.remove('svc-1')
      expect(manager.status('svc-1')).toBeNull()
      const port = Number(new URL(status.url).port)
      await expect(
        new Promise((resolve, reject) => {
          const socket = connect({ host: '127.0.0.1', port })
          socket.once('connect', () => {
            socket.destroy()
            reject(new Error('still listening'))
          })
          socket.once('error', () => resolve(undefined))
        })
      ).resolves.toBeUndefined()
    } finally {
      manager.shutdown()
      await backend.close()
    }
  })

  it('rejects an https:// target since there is nothing to terminate', async () => {
    const manager = new TlsProxyManager({ filePath: tempFile() })
    await expect(manager.ensure('svc-1', { url: 'https://127.0.0.1:9999' })).rejects.toThrow(
      /only needed in front of an http/
    )
  })
})
