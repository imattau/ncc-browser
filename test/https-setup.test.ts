import { X509Certificate } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import type { AddressInfo, Server } from 'node:net'
import { describe, expect, it } from 'vitest'
import { generateSelfSignedCertificate } from '../src/main/hosting/certificates'
import { HttpsSetup, hostKind, probeProtocol } from '../src/main/hosting/https-setup'
import { TlsProxyManager } from '../src/main/hosting/tls-proxy'
import { secureEndpoints, type HostedService, type ServiceEndpoint } from '../src/shared/hosting'

const own = new Set(['192.168.1.20'])
const kind = (host: string) => hostKind(host, own)
const endpoints = (...urls: string[]): ServiceEndpoint[] =>
  urls.map((url) => ({ url, priority: 1000 }))
const service = (...urls: string[]): HostedService =>
  ({ id: 'svc', service: 'svc', title: 'svc', endpoints: endpoints(...urls) }) as HostedService

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  )
}

function fetchOverTls(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    })
    let data = ''
    socket.on('data', (chunk) => (data += chunk.toString()))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

function manager(): TlsProxyManager {
  return new TlsProxyManager({
    filePath: join(mkdtempSync(join(tmpdir(), 'ncc-https-')), 'tls-proxies.json'),
    defaultPort: 0
  })
}

describe('secureEndpoints', () => {
  const front = { targetPort: 8080, listenPort: 8443, pin: 'PIN' }

  it('gives local addresses the HTTPS port and keeps the public port for the router', () => {
    const result = secureEndpoints(
      endpoints(
        'http://localhost:8080/',
        'https://192.168.1.20:8080/app',
        'http://203.0.113.7:8080/'
      ),
      front,
      kind
    )
    expect(result.endpoints.map((entry) => [entry.url, entry.k])).toEqual([
      ['https://localhost:8443/', 'PIN'],
      ['https://192.168.1.20:8443/app', 'PIN'],
      ['https://203.0.113.7:8080/', 'PIN']
    ])
    expect(result.routerPorts).toEqual([8080])
  })

  it('leaves onion, other ports and other LAN machines alone', () => {
    const untouched = endpoints(
      'http://abc.onion/',
      'https://photos.example/',
      'http://192.168.1.99:8080/'
    )
    expect(secureEndpoints(untouched, front, kind)).toEqual({
      endpoints: untouched,
      routerPorts: []
    })
  })

  it('keeps an explicit port 443 after switching from http port 80', () => {
    const result = secureEndpoints(
      endpoints('http://example.com/'),
      { ...front, targetPort: 80 },
      kind
    )
    expect(result.endpoints[0].url).toBe('https://example.com:80/')
  })

  it('drops the loopback proxy address saved by v0.47', () => {
    const result = secureEndpoints(
      [{ url: 'https://127.0.0.1:36197/', priority: 2, k: 'OLD', source: 'tls-proxy' }],
      front,
      kind
    )
    expect(result.endpoints).toEqual([])
  })
})

describe('HttpsSetup', () => {
  it('turns HTTPS on when an https:// address is really a plain HTTP server', async () => {
    const backend = createServer((_req, res) => res.end('plain backend'))
    const port = await listen(backend)
    const proxies = manager()
    try {
      expect(await probeProtocol('127.0.0.1', port)).toBe('http')
      await new HttpsSetup(proxies, probeProtocol, () => new Set()).prepare(
        service(`https://localhost:${port}/`, `https://203.0.113.7:${port}/`)
      )
      const front = proxies.status('svc')!
      expect(front.targetPort).toBe(port)
      expect(await probeProtocol('127.0.0.1', front.listenPort)).toBe('tls')
      expect(await fetchOverTls(front.listenPort)).toContain('plain backend')
    } finally {
      proxies.shutdown()
      backend.close()
    }
  })

  it('leaves a server that already speaks HTTPS alone', async () => {
    const { cert, key } = await generateSelfSignedCertificate({
      commonName: 'localhost',
      altNames: ['127.0.0.1']
    })
    const backend = createHttpsServer({ cert, key }, (_req, res) => res.end('tls'))
    const port = await listen(backend)
    const proxies = manager()
    try {
      await new HttpsSetup(proxies, probeProtocol, () => new Set()).prepare(
        service(`https://127.0.0.1:${port}/`)
      )
      expect(proxies.status('svc')).toBeNull()
    } finally {
      proxies.shutdown()
      backend.close()
    }
  })

  it('does not open anything for plain http:// addresses until asked', async () => {
    const backend = createServer((_req, res) => res.end('ok'))
    const port = await listen(backend)
    const proxies = manager()
    const setup = new HttpsSetup(proxies, probeProtocol, () => new Set())
    try {
      await setup.prepare(service(`http://127.0.0.1:${port}/`))
      expect(proxies.status('svc')).toBeNull()
      await setup.enable(service(`http://127.0.0.1:${port}/`))
      expect(proxies.status('svc')?.targetPort).toBe(port)
    } finally {
      proxies.shutdown()
      backend.close()
    }
  })

  it('follows the service to a new port and keeps the pin', async () => {
    const first = createServer((_req, res) => res.end('first'))
    const second = createServer((_req, res) => res.end('second'))
    const [a, b] = [await listen(first), await listen(second)]
    const proxies = manager()
    const setup = new HttpsSetup(proxies, probeProtocol, () => new Set())
    try {
      await setup.enable(service(`http://127.0.0.1:${a}/`))
      const before = proxies.status('svc')!
      await setup.prepare(service(`http://127.0.0.1:${b}/`))
      const after = proxies.status('svc')!
      expect(after.targetPort).toBe(b)
      expect(after.pin).toBe(before.pin)
      expect(await fetchOverTls(after.listenPort)).toContain('second')
    } finally {
      proxies.shutdown()
      first.close()
      second.close()
    }
  })

  it('uses a certificate that names no network address, replacing old ones', async () => {
    const backend = createServer((_req, res) => res.end('ok'))
    const port = await listen(backend)
    const filePath = join(mkdtempSync(join(tmpdir(), 'ncc-https-')), 'tls-proxies.json')
    const old = await generateSelfSignedCertificate({ commonName: '192.168.1.20' })
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        services: [
          { serviceId: 'svc', targetHost: '127.0.0.1', targetPort: port, listenPort: 0, cert: old.cert, key: old.key, pin: old.info.pin, createdAt: 1 }
        ]
      })
    )
    const proxies = new TlsProxyManager({ filePath, defaultPort: 0 })
    try {
      await proxies.restoreAll()
      const record = proxies.record('svc')!
      expect(record.pin).not.toBe(old.info.pin)
      expect(new X509Certificate(record.cert).subject).toBe('CN=localhost')
      expect(record.cert + new X509Certificate(record.cert).subjectAltName).not.toContain('192.168')
      await proxies.ensure('svc', { url: `http://127.0.0.1:${port}` })
      expect(proxies.record('svc')!.pin).toBe(record.pin)
    } finally {
      proxies.shutdown()
      backend.close()
    }
  })

  it('does not restart proxies for removed services', async () => {
    const backend = createServer((_req, res) => res.end('ok'))
    const port = await listen(backend)
    const proxies = manager()
    try {
      await proxies.ensure('gone', { url: `http://127.0.0.1:${port}` })
      proxies.shutdown()
      await proxies.restoreAll(() => false)
      expect(proxies.isRunning('gone')).toBe(false)
    } finally {
      proxies.shutdown()
      backend.close()
    }
  })
})
