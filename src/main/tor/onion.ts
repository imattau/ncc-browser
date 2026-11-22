/**
 * Persistent onion endpoints for hosted services.
 *
 * The onion private key never leaves this file. It is written `0600` and reused so
 * the address stays stable across restarts; removing the service deletes both the
 * key and the running onion service. Tor is only asked to re-attach when it is
 * already running, never started just to restore.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import type { OnionStatus } from '@shared/hosting'
import {
  TorControlError,
  type AddedOnion,
  type TorControlEndpoint,
  type TorControlLike
} from './control'

export interface OnionRecord {
  /** Hosted service id, not the onion host. */
  serviceId: string
  onionHost: string
  /** `ED25519-V3:…` secret returned by Tor. Sensitive. */
  privateKey: string
  virtualPort: number
  targetHost: string
  targetPort: number
  secure: boolean
  createdAt: number
  lastStartedAt?: number
  lastVerifiedAt?: number
  lastError?: string
}

interface OnionFile {
  version: 1
  services: OnionRecord[]
}

export interface OnionTarget {
  url: string
}

export interface OnionTor {
  ensureReady(): Promise<unknown>
  controlEndpoint(): TorControlEndpoint | null
  proxy(): string | null
}

export type OnionVerifier = (url: string, proxy: string | null, timeoutMs?: number) => Promise<boolean>

export interface OnionManagerOptions {
  filePath: string
  tor: OnionTor
  createControl?: (endpoint: TorControlEndpoint) => TorControlLike
  verify?: OnionVerifier
  now?: () => number
  verifyTimeoutMs?: number
  onChange?: () => void
  log?: (line: string) => void
}

export class OnionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnionUnavailableError'
  }
}

export function onionUrl(record: Pick<OnionRecord, 'onionHost' | 'virtualPort' | 'secure'>): string {
  const scheme = record.secure ? 'https' : 'http'
  const suffix = record.virtualPort === 80 || record.virtualPort === 443 ? '' : `:${record.virtualPort}`
  return `${scheme}://${record.onionHost}.onion${suffix}/`
}

export function statusFromRecord(record: OnionRecord): OnionStatus {
  return {
    serviceId: record.serviceId,
    host: `${record.onionHost}.onion`,
    url: onionUrl(record),
    target: `${record.targetHost}:${record.targetPort}`,
    verifiedAt: record.lastVerifiedAt,
    createdAt: record.createdAt,
    ...(record.lastError ? { error: record.lastError } : {})
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadFile(path: string): OnionFile {
  if (!existsSync(path)) return { version: 1, services: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OnionFile>
    const services = Array.isArray(parsed.services)
      ? parsed.services.filter(
          (record): record is OnionRecord =>
            typeof record?.serviceId === 'string' &&
            typeof record?.onionHost === 'string' &&
            typeof record?.privateKey === 'string' &&
            typeof record?.targetPort === 'number'
        )
      : []
    return { version: 1, services }
  } catch {
    return { version: 1, services: [] }
  }
}

export class OnionManager {
  private readonly now: () => number
  private readonly verify: OnionVerifier
  private readonly createControl: (endpoint: TorControlEndpoint) => TorControlLike
  private records: OnionRecord[]
  private control: TorControlLike | null = null
  private controlKey: string | null = null
  private restoring: Promise<void> | null = null

  constructor(private readonly options: OnionManagerOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.verify = options.verify ?? (async () => false)
    this.createControl = options.createControl ?? unavailableControl
    this.records = loadFile(options.filePath).services
  }

  statuses(): OnionStatus[] {
    return this.records.map(statusFromRecord)
  }

  status(serviceId: string): OnionStatus | null {
    const record = this.records.find((entry) => entry.serviceId === serviceId)
    return record ? statusFromRecord(record) : null
  }

  record(serviceId: string): OnionRecord | null {
    const record = this.records.find((entry) => entry.serviceId === serviceId)
    return record ? clone(record) : null
  }

  /** Create or refresh the onion endpoint for a service's local target. */
  async publish(serviceId: string, target: OnionTarget): Promise<OnionStatus> {
    const parsed = parseTarget(target)
    await this.options.tor.ensureReady()
    const control = await this.openControl()
    const existing = this.records.find((entry) => entry.serviceId === serviceId)
    if (existing) {
      // Re-adding with the stored key keeps the address stable if the target moved.
      await control.delOnion(existing.onionHost).catch(() => undefined)
    }
    let added: AddedOnion
    try {
      added = await control.addOnion({
        virtualPort: parsed.virtualPort,
        targetPort: parsed.targetPort,
        targetHost: '127.0.0.1',
        ...(existing ? { privateKey: existing.privateKey } : {})
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (existing) this.markError(existing, message)
      throw new OnionUnavailableError(`Tor could not create the onion service: ${message}`)
    }

    const at = this.now()
    const record: OnionRecord = {
      serviceId,
      onionHost: added.serviceId,
      privateKey: added.privateKey,
      virtualPort: parsed.virtualPort,
      targetHost: '127.0.0.1',
      targetPort: parsed.targetPort,
      secure: parsed.secure,
      createdAt: existing?.createdAt ?? at,
      lastStartedAt: at
    }
    const url = onionUrl(record)
    try {
      record.lastVerifiedAt = (await this.verify(url, this.options.tor.proxy(), this.options.verifyTimeoutMs))
        ? this.now()
        : undefined
    } catch {
      record.lastVerifiedAt = undefined
    }
    this.records = [...this.records.filter((entry) => entry.serviceId !== serviceId), record]
    this.flush()
    return statusFromRecord(record)
  }

  async remove(serviceId: string): Promise<void> {
    const record = this.records.find((entry) => entry.serviceId === serviceId)
    if (!record) return
    try {
      const control = await this.openControl()
      await control.delOnion(record.onionHost)
    } catch {
      // The onion is gone with Tor or will expire with it; the key must still go.
    }
    this.records = this.records.filter((entry) => entry.serviceId !== serviceId)
    this.flush()
  }

  /** Re-attach every stored onion to a running Tor. Called after Tor becomes ready. */
  restoreAll(): Promise<void> {
    if (this.restoring) return this.restoring
    this.restoring = this.restore().finally(() => {
      this.restoring = null
    })
    return this.restoring
  }

  private async restore(): Promise<void> {
    if (this.records.length === 0) return
    let control: TorControlLike
    try {
      await this.options.tor.ensureReady()
      control = await this.openControl()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const record of this.records) record.lastError = message.slice(0, 300)
      this.flush()
      return
    }
    for (const record of [...this.records]) {
      try {
        await control.delOnion(record.onionHost).catch(() => undefined)
        await control.addOnion({
          virtualPort: record.virtualPort,
          targetPort: record.targetPort,
          targetHost: record.targetHost,
          privateKey: record.privateKey
        })
        record.lastStartedAt = this.now()
        const verified = await this.verify(
          onionUrl(record),
          this.options.tor.proxy(),
          this.options.verifyTimeoutMs
        ).catch(() => false)
        record.lastVerifiedAt = verified ? this.now() : undefined
        delete record.lastError
        this.options.log?.(`restored onion ${record.onionHost}.onion`)
      } catch (error) {
        record.lastError = error instanceof Error ? error.message : String(error)
        this.options.log?.(`could not restore ${record.onionHost}.onion: ${record.lastError}`)
      }
    }
    this.flush()
  }

  async shutdown(): Promise<void> {
    if (!this.control) return
    for (const record of [...this.records]) {
      await this.control.delOnion(record.onionHost).catch(() => undefined)
    }
    this.control.close()
    this.control = null
    this.controlKey = null
  }

  private async openControl(): Promise<TorControlLike> {
    const endpoint = this.options.tor.controlEndpoint()
    if (!endpoint) {
      throw new OnionUnavailableError(
        'Tor is running without a control port. Onion services need the bundled Tor, or NCC_TOR_CONTROL for an external Tor.'
      )
    }
    const key = `${endpoint.host}:${endpoint.port}`
    if (this.control && this.controlKey === key) return this.control
    this.control?.close()
    this.control = this.createControl(endpoint)
    this.controlKey = key
    try {
      await this.control.connect()
    } catch (error) {
      this.control.close()
      this.control = null
      this.controlKey = null
      throw error instanceof TorControlError
        ? new OnionUnavailableError(error.message)
        : error
    }
    return this.control
  }

  private markError(record: OnionRecord, message: string): void {
    record.lastError = message.slice(0, 300)
    this.flush()
  }

  private flush(): void {
    const payload: OnionFile = { version: 1, services: this.records }
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

function parseTarget(target: OnionTarget): {
  virtualPort: number
  targetPort: number
  secure: boolean
} {
  let url: URL
  try {
    url = new URL(target.url)
  } catch {
    throw new OnionUnavailableError('The service endpoint is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OnionUnavailableError('Tor forwarding needs an http:// or https:// endpoint')
  }
  const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
    throw new OnionUnavailableError('The service endpoint has no usable port')
  }
  const secure = url.protocol === 'https:'
  return { virtualPort: secure ? 443 : 80, targetPort, secure }
}

/**
 * Connect to an onion through the same SOCKS proxy the browser uses. A successful
 * CONNECT means Tor built a circuit and the hidden service accepted the stream.
 */
export function verifyOnionThroughSocks(
  url: string,
  proxy: string | null,
  timeoutMs = 20_000
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!proxy) return resolve(false)
    let host: string
    let port: number
    let target: URL
    try {
      const parsed = new URL(proxy.includes('://') ? proxy : `socks5://${proxy}`)
      host = parsed.hostname
      port = Number(parsed.port || 9050)
      target = new URL(url)
    } catch {
      return resolve(false)
    }
    const targetHost = target.hostname
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const socket = createConnection({ host, port })
    let settled = false
    let stage: 'greeting' | 'connect' = 'greeting'
    let buffer = Buffer.alloc(0)
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false))
    socket.on('connect', () => {
      socket.write(Buffer.from([5, 1, 0]))
    })
    const sendConnect = (): void => {
      const name = Buffer.from(targetHost, 'utf8')
      if (name.length > 255) return finish(false)
      const request = Buffer.alloc(7 + name.length)
      request[0] = 5
      request[1] = 1
      request[2] = 0
      request[3] = 3
      request[4] = name.length
      name.copy(request, 5)
      request.writeUInt16BE(targetPort, 5 + name.length)
      socket.write(request)
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish(false)
        buffer = buffer.slice(2)
        stage = 'connect'
        sendConnect()
        return
      }
      if (buffer.length < 4) return
      if (buffer[1] !== 0) return finish(false)
      const addressType = buffer[3]
      let length: number
      if (addressType === 1) length = 4 + 4 + 2
      else if (addressType === 4) length = 4 + 16 + 2
      else if (addressType === 3) {
        if (buffer.length < 5) return
        length = 4 + 1 + buffer[4] + 2
      } else return finish(false)
      if (buffer.length < length) return
      finish(true)
    })
  })
}

function unavailableControl(): TorControlLike {
  const fail = async (): Promise<never> => {
    throw new OnionUnavailableError(
      'Onion services are unavailable: the bundled Tor must run, or set NCC_TOR_CONTROL.'
    )
  }
  return {
    connect: fail,
    addOnion: fail,
    delOnion: fail,
    close: () => undefined
  }
}
