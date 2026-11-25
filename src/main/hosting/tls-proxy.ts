/**
 * HTTPS in front of hosted services whose server only speaks plain HTTP.
 *
 * Nostr Navigator never asks a publisher to install anything on their own server.
 * This listens on a TLS socket with a locally generated self-signed certificate and
 * forwards the raw TCP stream to the real server. It listens on every interface so
 * visitors on the LAN, or through a router forward, can reach it. The published
 * endpoints carry the certificate's SPKI pin as `k` (see `secureEndpoints`), so a
 * visiting NCC resolver accepts it like any other endpoint.
 *
 * The server sees every visitor as a connection from this machine, so it must not
 * treat local connections as trusted.
 *
 * The certificate and key are persisted per service so the published pin stays
 * stable across restarts, the same way the onion manager reuses its stored key.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { dirname } from 'node:path'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import type { TlsProxyStatus } from '@shared/hosting'
import { generateSelfSignedCertificate } from './certificates'

export interface TlsProxyRecord {
  serviceId: string
  targetHost: string
  targetPort: number
  listenPort: number
  cert: string
  key: string
  pin: string
  createdAt: number
  lastError?: string
}

export type { TlsProxyStatus }

interface TlsProxyFile {
  version: 1
  services: TlsProxyRecord[]
}

/** Tried first, so the router rule is easy to recognise. */
export const DEFAULT_HTTPS_PORT = 8443

export interface TlsProxyManagerOptions {
  filePath: string
  /** Override for tests. */
  defaultPort?: number
  now?: () => number
  onChange?: () => void
  log?: (line: string) => void
}

export class TlsProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TlsProxyUnavailableError'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadFile(path: string): TlsProxyFile {
  if (!existsSync(path)) return { version: 1, services: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TlsProxyFile>
    const services = Array.isArray(parsed.services)
      ? parsed.services.filter(
          (record): record is TlsProxyRecord =>
            typeof record?.serviceId === 'string' &&
            typeof record?.targetHost === 'string' &&
            typeof record?.targetPort === 'number' &&
            typeof record?.cert === 'string' &&
            typeof record?.key === 'string' &&
            typeof record?.pin === 'string'
        )
      : []
    return { version: 1, services }
  } catch {
    return { version: 1, services: [] }
  }
}

export function statusFromRecord(record: TlsProxyRecord): TlsProxyStatus {
  return {
    serviceId: record.serviceId,
    url: `https://127.0.0.1:${record.listenPort}/`,
    listenPort: record.listenPort,
    targetPort: record.targetPort,
    pin: record.pin,
    target: `${record.targetHost}:${record.targetPort}`
  }
}

function listen(
  server: ReturnType<typeof createTlsServer>,
  port: number,
  host: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      server.removeAllListeners('listening')
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new TlsProxyUnavailableError('The HTTPS front has no local port'))
        return
      }
      resolve(address.port)
    })
  })
}

/** Listen on the first free port, on IPv6 and IPv4 where the system allows both. */
async function listenOnFreePort(
  server: ReturnType<typeof createTlsServer>,
  preferred: number[]
): Promise<number> {
  let host = '::'
  const ports = [...preferred.filter((port) => port > 0), 0]
  for (let index = 0; ; ) {
    try {
      return await listen(server, ports[index], host)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      server.removeAllListeners('listening')
      if (host === '::' && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL')) {
        host = '0.0.0.0'
        continue
      }
      index += 1
      if (index >= ports.length || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error
    }
  }
}

export class TlsProxyManager {
  private readonly now: () => number
  private records: TlsProxyRecord[]
  private readonly servers = new Map<string, ReturnType<typeof createTlsServer>>()

  constructor(private readonly options: TlsProxyManagerOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.records = loadFile(options.filePath).services
  }

  statuses(): TlsProxyStatus[] {
    return this.records.map(statusFromRecord)
  }

  status(serviceId: string): TlsProxyStatus | null {
    const record = this.records.find((entry) => entry.serviceId === serviceId)
    return record ? statusFromRecord(record) : null
  }

  record(serviceId: string): TlsProxyRecord | null {
    const record = this.records.find((entry) => entry.serviceId === serviceId)
    return record ? clone(record) : null
  }

  isRunning(serviceId: string): boolean {
    return this.servers.has(serviceId)
  }

  /**
   * Start, or restart, the HTTPS front for a service's `http://` server. The stored
   * certificate and listen port are reused, so published addresses and pins stay
   * stable.
   */
  async ensure(serviceId: string, target: { url: string }): Promise<TlsProxyStatus> {
    const parsed = parseHttpTarget(target.url)
    const existing = this.records.find((entry) => entry.serviceId === serviceId)
    this.stopServer(serviceId)

    let cert: string
    let key: string
    let pin: string
    if (existing) {
      ;({ cert, key, pin } = existing)
    } else {
      const generated = await generateSelfSignedCertificate({
        commonName: parsed.host,
        altNames: ['127.0.0.1', '::1', 'localhost']
      })
      cert = generated.cert
      key = generated.key
      pin = generated.info.pin
    }

    const listenPort = await this.listenWithFallback(serviceId, cert, key, parsed, existing?.listenPort ?? 0)

    const record: TlsProxyRecord = {
      serviceId,
      targetHost: parsed.host,
      targetPort: parsed.port,
      listenPort,
      cert,
      key,
      pin,
      createdAt: existing?.createdAt ?? this.now()
    }
    this.records = [...this.records.filter((entry) => entry.serviceId !== serviceId), record]
    this.flush()
    return statusFromRecord(record)
  }

  async remove(serviceId: string): Promise<void> {
    this.stopServer(serviceId)
    if (!this.records.some((entry) => entry.serviceId === serviceId)) return
    this.records = this.records.filter((entry) => entry.serviceId !== serviceId)
    this.flush()
  }

  /**
   * Restart persisted proxies at app startup. `wanted` skips any whose service no
   * longer exists, so nothing keeps listening for a removed service.
   */
  async restoreAll(wanted: (serviceId: string) => boolean = () => true): Promise<void> {
    for (const record of [...this.records]) {
      if (!wanted(record.serviceId)) continue
      try {
        const host = record.targetHost.includes(':') ? `[${record.targetHost}]` : record.targetHost
        await this.ensure(record.serviceId, { url: `http://${host}:${record.targetPort}` })
        this.options.log?.(`restored https for ${record.serviceId} on :${record.listenPort}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.log?.(`could not restore https for ${record.serviceId}: ${message}`)
      }
    }
  }

  shutdown(): void {
    for (const serviceId of [...this.servers.keys()]) this.stopServer(serviceId)
  }

  private async listenWithFallback(
    serviceId: string,
    cert: string,
    key: string,
    target: { host: string; port: number },
    preferredPort: number
  ): Promise<number> {
    const server = createTlsServer({ cert, key }, (socket: TLSSocket) => {
      const upstream = connectTcp(target.port, target.host)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    const port = await listenOnFreePort(server, [
      preferredPort || (this.options.defaultPort ?? DEFAULT_HTTPS_PORT)
    ])
    this.servers.set(serviceId, server)
    return port
  }

  private stopServer(serviceId: string): void {
    const server = this.servers.get(serviceId)
    if (!server) return
    server.close()
    this.servers.delete(serviceId)
  }

  private flush(): void {
    const payload: TlsProxyFile = { version: 1, services: this.records }
    const path = this.options.filePath
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
    chmodSync(path, 0o600)
    this.options.onChange?.()
  }
}

function parseHttpTarget(input: string): { host: string; port: number } {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TlsProxyUnavailableError('The service endpoint is not a URL')
  }
  if (url.protocol !== 'http:') {
    throw new TlsProxyUnavailableError('A TLS proxy is only needed in front of an http:// endpoint')
  }
  const port = Number(url.port || 80)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TlsProxyUnavailableError('The service endpoint has no usable port')
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
}
