/**
 * Serves a tiny Tor-only PAC over loopback and applies it to the content session.
 *
 * Chromium's PAC loader rejected file/data URLs in testing, so a loopback HTTP
 * endpoint with an unguessable path is the reliable option. The PAC itself contains
 * only the SOCKS proxy address.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Session } from 'electron'
import { buildTorPac } from './proxy'

export class TorSessionProxy {
  private readonly token = randomBytes(16).toString('hex')
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private port = 0
  private pac = ''

  constructor(private readonly session: Session) {}

  async start(): Promise<void> {
    if (this.server) return
    if (this.starting) return this.starting
    this.starting = this.listen().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      if (!request.url?.startsWith(`/${this.token}.pac`)) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'application/x-ns-proxy-autoconfig',
        'cache-control': 'no-store'
      })
      response.end(this.pac)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject)
        this.server?.listen(0, '127.0.0.1', () => {
          this.port = (this.server?.address() as AddressInfo).port
          resolve()
        })
      })
    } catch (error) {
      this.server = null
      this.port = 0
      throw error
    }
  }

  async apply(proxy: string | null): Promise<void> {
    if (!proxy) {
      await this.session.setProxy({ mode: 'system' })
      return
    }
    await this.start()
    this.pac = buildTorPac(proxy)
    await this.session.setProxy({
      mode: 'pac_script',
      pacScript: `http://127.0.0.1:${this.port}/${this.token}.pac?v=${Date.now()}`
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
