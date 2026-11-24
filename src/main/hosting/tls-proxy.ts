/**
 * Local TLS termination for hosted services whose backend only speaks `http://`.
 *
 * Nostr Navigator never asks a publisher to install anything on their own server.
 * Instead, when a service endpoint is plain HTTP, this listens on a loopback TLS
 * socket with a locally generated self-signed certificate and forwards the raw TCP
 * stream to the real backend. The published locator gets the proxy's `https://`
 * address with `k` set to that certificate's SPKI pin, so a visiting NCC resolver
 * pins and accepts it exactly like any other endpoint; nothing about this is visible
 * to the backend or to the publisher beyond an endpoint that happens to be HTTPS.
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

export interface TlsProxyManagerOptions {
  filePath: string
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
    pin: record.pin,
    target: `${record.targetHost}:${record.targetPort}`
  }
}

function listenOnFreePort(server: ReturnType<typeof createTlsServer>, preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, fallbackToEphemeral: boolean): void => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (fallbackToEphemeral && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
          server.removeAllListeners('error')
          tryListen(0, false)
          return
        }
        reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new TlsProxyUnavailableError('The TLS proxy has no local port'))
          return
        }
        resolve(address.port)
      })
    }
    tryListen(preferred && preferred > 0 ? preferred : 0, Boolean(preferred))
  })
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

  /**
   * Start, or restart, the local TLS terminator for a service's `http://` endpoint.
   * Reuses the stored certificate and listen port when one already exists for this
   * service, so the published address and pin stay stable.
   */
  async ensure(serviceId: string, target: { url: string }): Promise<TlsProxyStatus> {
    const parsed = parseHttpTarget(target.url)
    const existing = this.records.find((entry) => entry.serviceId === serviceId)
    this.stopServer(serviceId)

    let cert: string
    let key: string
    let pin: string
    if (existing && existing.targetHost === parsed.host && existing.targetPort === parsed.port) {
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

  /** Restart every persisted proxy. Called once at app startup. */
  async restoreAll(): Promise<void> {
    for (const record of [...this.records]) {
      try {
        await this.ensure(record.serviceId, { url: `http://${record.targetHost}:${record.targetPort}` })
        this.options.log?.(`restored tls proxy for ${record.serviceId} on :${record.listenPort}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.log?.(`could not restore tls proxy for ${record.serviceId}: ${message}`)
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
    const port = await listenOnFreePort(server, preferredPort)
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
