import { finalizeEvent, getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools'
export { decodeBolt11Invoice } from './bolt11'

export interface NwcConnection {
  pubkey: string
  relays: string[]
  secret: Uint8Array
  lud16?: string
}
export interface NwcInvoice {
  invoice: string
  amountMsat: string
  description?: string
  descriptionHash?: string
  expiry?: number
}

export interface NwcPayment {
  preimage?: string
  feesPaidMsat?: string
}

/** Spaces, line breaks and characters that take no room on screen. None belong in a URI. */
const UNSEEN = /[\s\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
/** The address, wherever it starts. It ends at a closing quote or angle bracket. */
const NWC_ADDRESS = /nostr\+?walletconnect:(?:\/\/)?([^"'`<>\u2018\u2019\u201c\u201d\u00ab\u00bb]*)/i

/**
 * Tidies what was pasted into `nostr+walletconnect://…`. Copying from a wallet, chat or
 * web page often adds quotes, a label, line breaks or invisible characters, which the
 * user cannot see in a hidden field. The older `nostrwalletconnect:` spelling and a
 * wholly percent-encoded link are accepted too. Text without an address is returned
 * as it is, for the checks to reject.
 */
export function normalizeNwcUri(input: string): string {
  let text = input.replace(UNSEEN, '')
  if (!NWC_ADDRESS.test(text) && /walletconnect%3a/i.test(text)) {
    try { text = decodeURIComponent(text) } catch { return text }
  }
  const found = NWC_ADDRESS.exec(text)
  return found ? `nostr+walletconnect://${found[1].replace(/[.,;)]+$/, '')}` : text
}

export function parseNwcUri(input: string): NwcConnection {
  let url: URL
  try { url = new URL(normalizeNwcUri(input)) } catch {
    throw new Error('Paste a Nostr Wallet Connect URI. It starts with nostr+walletconnect://')
  }
  if (url.protocol !== 'nostr+walletconnect:' || !/^[0-9a-f]{64}$/i.test(url.hostname || url.pathname.replace(/^\//, ''))) {
    throw new Error('NWC URI must use nostr+walletconnect:// and include a wallet public key')
  }
  const pubkey = (url.hostname || url.pathname.replace(/^\//, '')).toLowerCase()
  const secretText = url.searchParams.get('secret') ?? ''
  if (!/^[0-9a-f]{64}$/i.test(secretText)) throw new Error('NWC URI must include a 32-byte hex secret')
  const relays = url.searchParams.getAll('relay').map((relay) => {
    let parsed: URL
    try { parsed = new URL(relay) } catch { throw new Error('NWC URI contains an invalid relay URL') }
    if (!['wss:', 'ws:'].includes(parsed.protocol)) throw new Error('NWC relays must use WebSocket URLs')
    return parsed.toString()
  })
  if (!relays.length) throw new Error('NWC URI must include at least one relay')
  const secret = Uint8Array.from(secretText.match(/../g)!, (byte) => Number.parseInt(byte, 16))
  return { pubkey, relays, secret, lud16: url.searchParams.get('lud16') ?? undefined }
}

/** NIP-47 encrypted request/response transport. The caller supplies its platform relay pool. */
export class NwcClient {
  private readonly clientPubkey: string
  private readonly conversationKey: Uint8Array

  constructor(private readonly connection: NwcConnection, private readonly transport: NwcTransport) {
    this.clientPubkey = getPublicKey(connection.secret)
    this.conversationKey = nip44.v2.utils.getConversationKey(connection.secret, connection.pubkey)
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = crypto.randomUUID()
    const created_at = Math.floor(Date.now() / 1000)
    const content = nip44.v2.encrypt(JSON.stringify({ method, params }), this.conversationKey)
    const event = finalizeEvent({
      kind: 23194,
      created_at,
      tags: [['p', this.connection.pubkey], ['encryption', 'nip44_v2'], ['expiration', String(created_at + 60)]],
      content
    }, this.connection.secret) as Event
    const response = this.transport.waitForResponse(this.connection, this.clientPubkey, event.id, 60_000)
    try { await this.transport.publish(this.connection.relays, event) }
    catch (error) { void response.catch(() => undefined); throw error }
    const reply = await response
    if (!verifyEvent(reply) || reply.pubkey !== this.connection.pubkey ||
      !reply.tags.some((tag) => tag[0] === 'e' && tag[1] === event.id) ||
      !reply.tags.some((tag) => tag[0] === 'p' && tag[1] === this.clientPubkey)) {
      throw new Error('NWC wallet response could not be verified')
    }
    const plaintext = nip44.v2.decrypt(reply.content, this.conversationKey)
    const data = JSON.parse(plaintext) as { result_type?: string; result?: T; error?: { message?: string } | null }
    if (data.result_type !== method) throw new Error('NWC wallet returned a mismatched response')
    if (data.error) throw new Error(data.error.message || 'NWC wallet request failed')
    return data.result as T
  }

  getInfo() { return this.request<{ alias?: string; color?: string; network?: string; methods?: string[] }>('get_info') }
  getBalance() { return this.request<{ balance: number }>('get_balance') }
  payInvoice(invoice: string) { return this.request<NwcPayment>('pay_invoice', { invoice }) }
  makeInvoice(params: { amount: number; description?: string; description_hash?: string; expiry?: number }) { return this.request<NwcInvoice>('make_invoice', params) }
  lookupInvoice(params: { payment_hash?: string; invoice?: string }) { return this.request<NwcInvoice & NwcPayment>('lookup_invoice', params) }
  dispose() { this.connection.secret.fill(0); this.conversationKey.fill(0) }
}

export interface NwcTransport {
  publish(relays: string[], event: Event): Promise<void>
  waitForResponse(connection: NwcConnection, clientPubkey: string, eventId: string, timeoutMs: number): Promise<Event>
}
