import { timingSafeEqual } from 'node:crypto'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpHandler } from './mcp'
import type { AutomationGate, AutomationHost } from './types'

const MAX_BODY = 1_000_000

/** One agent this server currently accepts requests from. */
export interface ServerAgent {
  id: string
  /** The bearer value (the agent's nsec) that authenticates it. */
  nsec: string
  gate: AutomationGate
}

export interface AutomationServerOptions {
  host: AutomationHost
  version: string
  /** Where to write `{ url, agents }` so a dev script can find the server. */
  infoFile: string
  /** Preferred port; if it is taken the server falls back to a free one. */
  port?: number
  /** The agents currently allowed to connect, looked up fresh on every request. */
  agents(): ServerAgent[]
}

/**
 * Loopback-only MCP endpoint. Each agent authenticates with its own bearer token (its
 * nsec), and Host/Origin are checked so a web page cannot reach it through DNS rebinding.
 */
export class AutomationServer {
  private server: Server | null = null
  private readonly handler: McpHandler

  constructor(private readonly options: AutomationServerOptions) {
    this.handler = new McpHandler(options.host, { authorize: async () => false }, {
      name: 'nostr-navigator',
      version: options.version
    })
  }

  async start(): Promise<string> {
    const listen = (port: number): Promise<Server> =>
      new Promise((resolve, reject) => {
        const candidate = createServer((req, res) => void this.route(req, res))
        candidate.once('error', reject)
        candidate.listen(port, '127.0.0.1', () => resolve(candidate))
      })
    let server: Server
    try {
      server = await listen(this.options.port ?? 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      server = await listen(0)
    }
    this.server = server
    this.writeInfo()
    const url = this.url as string
    return url
  }

  stop(): void {
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = null
    rmSync(this.options.infoFile, { force: true })
  }

  /** Called whenever the agent list changes, so the dev info file stays current. */
  refresh(): void {
    if (this.server) this.writeInfo()
  }

  get url(): string | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}/mcp` : null
  }

  private writeInfo(): void {
    const url = this.url
    if (!url) return
    const agents = this.options.agents().map((agent) => ({ id: agent.id, nsec: agent.nsec }))
    writeFileSync(this.options.infoFile, JSON.stringify({ url, agents }), { mode: 0o600 })
    try {
      chmodSync(this.options.infoFile, 0o600)
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  }

  /** The agent whose nsec matches this request's bearer header, compared in constant time. */
  private authenticate(req: IncomingMessage): ServerAgent | null {
    const header = req.headers.authorization ?? ''
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''))
    let match: ServerAgent | null = null
    for (const agent of this.options.agents()) {
      const expected = Buffer.from(agent.nsec)
      if (given.length === expected.length && timingSafeEqual(given, expected)) match = agent
    }
    return match
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }

    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(403)
    if (req.headers.origin) return send(403) // Browsers send Origin; MCP clients do not.
    if (req.url?.split('?')[0] !== '/mcp') return send(404)
    const agent = this.authenticate(req)
    if (!agent) return send(401)
    if (req.method !== 'POST') return send(405)

    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY) return send(413)
      }
    } catch {
      return send(400)
    }

    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }

    if (Array.isArray(message)) {
      const replies = (
        await Promise.all(message.map((entry) => this.handler.handle(entry, agent.gate)))
      ).filter((entry) => entry !== null)
      return replies.length ? send(200, replies) : send(202)
    }
    const reply = await this.handler.handle(message, agent.gate)
    return reply ? send(200, reply) : send(202)
  }
}
