/**
 * Minimal Tor control-port client.
 *
 * Only what an onion service needs: cookie authentication, `ADD_ONION` and
 * `DEL_ONION`. The protocol is line based; a reply is one or more `250-…` lines
 * ending in `250 OK`, optionally with a `250+…` data block.
 */

import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'

export interface TorControlOptions {
  port: number
  host?: string
  /** Cookie authentication file. Tor creates it inside its data directory. */
  cookiePath?: string
  /** Raw control password, used instead of a cookie when given. */
  password?: string
  timeoutMs?: number
  connectTimeoutMs?: number
}

export type TorControlEndpoint = Omit<TorControlOptions, 'timeoutMs' | 'connectTimeoutMs'>

export interface TorReply {
  code: number
  lines: string[]
}

export interface AddOnionOptions {
  /** `80` or `443` on the onion side. */
  virtualPort: number
  /** Local service port. The target host is always loopback. */
  targetPort: number
  targetHost?: string
  /** Reuse an existing key (`ED25519-V3:…`) instead of generating one. */
  privateKey?: string
}

export interface AddedOnion {
  serviceId: string
  privateKey: string
}

export class TorControlError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'TorControlError'
  }
}

export interface TorControlLike {
  connect(): Promise<void>
  addOnion(options: AddOnionOptions): Promise<AddedOnion>
  delOnion(serviceId: string): Promise<void>
  close(): void
}

const ONION_ID = /^[a-z2-7]{16,56}$/

export function onionServiceIdFromHost(host: string): string | null {
  const value = host.trim().toLowerCase().replace(/\.onion\.?$/, '')
  return ONION_ID.test(value) ? value : null
}

/**
 * Parse a `250-ServiceID=…` / `250-PrivateKey=…` reply body. Tor sends the key only
 * when it generated one, so a request made with `suppliedKey` gets just the id back.
 */
export function parseOnionReply(reply: TorReply, suppliedKey?: string): AddedOnion {
  const serviceId = reply.lines
    .map((line) => /^ServiceID=(.+)$/.exec(line)?.[1]?.trim())
    .find(Boolean)
  const privateKey =
    reply.lines.map((line) => /^PrivateKey=(.+)$/.exec(line)?.[1]?.trim()).find(Boolean) ??
    suppliedKey
  if (!serviceId || !privateKey) {
    throw new TorControlError('Tor did not return the onion service id and key', reply.code)
  }
  return { serviceId, privateKey }
}

export class TorControl implements TorControlLike {
  private socket: Socket | null = null
  private buffer = ''
  private readonly lines: string[] = []
  private inDataBlock = false
  private pending: Array<{
    resolve: (reply: TorReply) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly options: TorControlOptions) {}

  async connect(): Promise<void> {
    if (this.socket) return
    const host = this.options.host ?? '127.0.0.1'
    const connectTimeout = this.options.connectTimeoutMs ?? 5000
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port: this.options.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new TorControlError(`Tor control port ${host}:${this.options.port} did not answer`))
      }, connectTimeout)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.attach(socket)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new TorControlError(`Tor control: ${error.message}`))
      })
    })
    await this.authenticate()
  }

  private async authenticate(): Promise<void> {
    const password = this.options.password
    if (password) {
      await this.command(`AUTHENTICATE "${password.replace(/"/g, '\\"')}"`)
      return
    }
    const cookiePath = this.options.cookiePath
    if (!cookiePath) {
      await this.command('AUTHENTICATE')
      return
    }
    // Tor writes the cookie after the control port opens.
    let cookie: Buffer | null = null
    for (let attempt = 0; attempt < 20 && !cookie; attempt += 1) {
      try {
        cookie = readFileSync(cookiePath)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (!cookie) {
      throw new TorControlError(`Tor control cookie ${cookiePath} was not readable`)
    }
    await this.command(`AUTHENTICATE ${cookie.toString('hex')}`)
  }

  addOnion(options: AddOnionOptions): Promise<AddedOnion> {
    const targetHost = options.targetHost ?? '127.0.0.1'
    const supplied = options.privateKey
      ? `ED25519-V3:${normalizeKey(options.privateKey)}`
      : undefined
    const command = `ADD_ONION ${supplied ?? 'NEW:ED25519-V3'} Port=${options.virtualPort},${targetHost}:${options.targetPort}`
    return this.command(command).then((reply) => parseOnionReply(reply, supplied))
  }

  async delOnion(serviceId: string): Promise<void> {
    if (!ONION_ID.test(serviceId)) throw new TorControlError('Invalid onion service id')
    await this.command(`DEL_ONION ${serviceId}`)
  }

  close(): void {
    this.closed = true
    this.socket?.destroy()
    this.socket = null
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer)
      entry.reject(new TorControlError('Tor control connection closed'))
    }
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  command(line: string): Promise<TorReply> {
    return this.run(() => this.send(line))
  }

  private send(line: string): Promise<TorReply> {
    const socket = this.socket
    if (!socket || this.closed) return Promise.reject(new TorControlError('Tor control is not connected'))
    return new Promise<TorReply>((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 15_000
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((entry) => entry.timer !== timer)
        reject(new TorControlError(`Tor control timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.push({ resolve, reject, timer })
      socket.write(`${line}\r\n`)
    })
  }

  private attach(socket: Socket): void {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.consume(chunk))
    socket.on('close', () => this.failAll('Tor control connection closed'))
    socket.on('error', (error) => this.failAll(`Tor control: ${error.message}`))
  }

  private failAll(message: string): void {
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer)
      entry.reject(new TorControlError(message))
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\r\n')
      if (index === -1) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      if (this.inDataBlock) {
        if (line === '.') {
          this.inDataBlock = false
          this.finish(250)
        } else {
          this.lines.push(line.startsWith('..') ? line.slice(1) : line)
        }
        continue
      }
      const match = /^(\d{3})([ +-])(.*)$/.exec(line)
      if (!match) continue
      const code = Number(match[1])
      const separator = match[2]
      const text = match[3]
      this.lines.push(text)
      if (separator === ' ') {
        this.finish(code)
      } else if (separator === '+') {
        this.inDataBlock = true
      }
    }
  }

  private finish(code: number): void {
    const entry = this.pending.shift()
    const lines = this.lines.splice(0)
    if (!entry) return
    clearTimeout(entry.timer)
    if (code >= 200 && code < 300) {
      entry.resolve({ code, lines })
    } else {
      entry.reject(new TorControlError(lines.filter(Boolean).join('; ') || `Tor control error ${code}`, code))
    }
  }
}

function normalizeKey(key: string): string {
  return key.replace(/^ED25519-V3:/i, '')
}
