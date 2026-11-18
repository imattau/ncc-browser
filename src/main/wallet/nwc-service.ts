import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Event } from 'nostr-tools'
import type { NwcSnapshot } from '@shared/wallet'
import type { RelayPool } from '../relay/pool'
import { NwcClient, parseNwcUri, type NwcTransport } from '@shared/nwc'

export class NwcService {
  private client: NwcClient | null = null
  private info: { alias?: string; network?: string; methods?: string[] } | null = null
  private lud16: string | null = null
  private readonly transport: NwcTransport

  constructor(private readonly path: string, private readonly relayPool: RelayPool, private readonly seal: (value: string) => string, private readonly unseal: (value: string) => string) {
    this.transport = {
      publish: (relays, event) => relayPool.publishMany(relays, event as Event),
      waitForResponse: (connection, clientPubkey, eventId, timeoutMs) => relayPool.waitForNwcResponse(connection.relays, connection.pubkey, clientPubkey, eventId, timeoutMs)
    }
    this.load()
  }

  status(): NwcSnapshot { return { connected: Boolean(this.client), alias: this.info?.alias ?? null, network: this.info?.network ?? null, balanceMsat: null, methods: this.info?.methods ?? [], lud16: this.lud16 } }

  async connect(uri: string): Promise<NwcSnapshot> {
    const connection = parseNwcUri(uri)
    const client = new NwcClient(connection, this.transport)
    try {
      const info = await client.getInfo()
      this.save(uri)
      this.client?.dispose()
      this.client = client
      this.info = info
      this.lud16 = connection.lud16 ?? null
      return this.status()
    } catch (error) { client.dispose(); throw error }
  }

  async refresh(): Promise<NwcSnapshot> {
    if (!this.client) return this.status()
    const [info, balance] = await Promise.all([this.client.getInfo(), this.client.getBalance()])
    this.info = info
    return { ...this.status(), balanceMsat: balance.balance }
  }

  disconnect(): void {
    this.client?.dispose(); this.client = null; this.info = null; this.lud16 = null
    try { if (existsSync(this.path)) unlinkSync(this.path) } catch { /* best effort */ }
  }

  dispose(): void { this.client?.dispose(); this.client = null; this.info = null; this.lud16 = null }

  getInfo() {
    if (!this.client) throw new Error('Connect a Lightning wallet first')
    return this.client.getInfo()
  }

  getBalance() {
    if (!this.client) throw new Error('Connect a Lightning wallet first')
    return this.client.getBalance()
  }

  payInvoice(invoice: string) {
    if (!this.client) throw new Error('Connect a Lightning wallet first')
    return this.client.payInvoice(invoice)
  }

  makeInvoice(params: { amount: number; description?: string; expiry?: number }) {
    if (!this.client) throw new Error('Connect a Lightning wallet first')
    return this.client.makeInvoice(params)
  }

  lookupInvoice(params: { payment_hash?: string; invoice?: string }) {
    if (!this.client) throw new Error('Connect a Lightning wallet first')
    return this.client.lookupInvoice(params)
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const record = JSON.parse(readFileSync(this.path, 'utf8')) as { ciphertext?: string }
      if (!record.ciphertext) return
      const uri = this.unseal(record.ciphertext)
      const connection = parseNwcUri(uri)
      this.client = new NwcClient(connection, this.transport)
      this.lud16 = connection.lud16 ?? null
      void this.client.getInfo().then((info) => { this.info = info }).catch(() => undefined)
    } catch { this.client = null }
  }

  private save(uri: string): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, ciphertext: this.seal(uri) })}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
  }
}
