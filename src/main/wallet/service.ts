import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools'
import { DEFAULT_ESPLORA_URL, type BitcoinSendPreview, type MoneroWalletRecord, type WalletSnapshot, type WalletStatus } from '@shared/wallet'
import type { IdentityManager } from '../signer/manager'
import type { IdentityStore } from '../signer/identity'
import { decryptNip44, encryptNip44 } from '../signer/crypto'
import type { RelayPool } from '../relay/pool'
import { BitcoinWallet, parseBtcAmount } from './bitcoin'

interface WalletPrefs { version: 1; esploraUrl: string }
const MONERO_D_TAG = 'ncc-browser/monero-wallet/v1'

export class WalletService {
  private prefs: WalletPrefs
  private bitcoin: BitcoinWallet

  constructor(
    private readonly filePath: string,
    private readonly localIdentity: IdentityStore,
    private readonly identity: IdentityManager,
    private readonly torProxy: () => string | null = () => null,
    private readonly requester?: ConstructorParameters<typeof BitcoinWallet>[3],
    private readonly moneroPath?: string,
    private readonly relays?: () => string[] | Promise<string[]>,
    private readonly relayPool?: RelayPool
  ) {
    this.prefs = this.readPrefs()
    this.bitcoin = this.makeBitcoin()
  }

  status(): WalletStatus {
    const status = this.identity.status()
    const local = status.mode === 'local' && status.configured
    let address: string | null = null
    if (local) {
      try {
        const secret = this.identity.activeLocalSecret()
        if (secret) address = this.bitcoin.address(secret)
      } catch { /* Identity is currently locked. */ }
    }
    return {
      identityReady: local && this.identity.activeLocalSecret() !== null,
      bitcoinAvailable: Boolean(address),
      moneroConfigured: false,
      moneroSyncChoice: null,
      bitcoinAddress: address,
      moneroAddress: null,
      error: local ? null : 'Bitcoin spending requires an unlocked local Nostr identity.'
    }
  }

  async snapshot(): Promise<WalletSnapshot> {
    const status = this.status()
    if (!status.bitcoinAddress) return { status, balances: [], transactions: [], receive: [] }
    const secret = this.requireLocalSecret()
    try {
      const data = await this.bitcoin.snapshot(secret)
      return {
        status,
        balances: [data.balance],
        transactions: data.transactions,
        receive: [{ currency: 'BTC', address: status.bitcoinAddress }]
      }
    } finally { secret.fill(0) }
  }

  async prepareBitcoinSend(address: string, amount: string): Promise<BitcoinSendPreview> {
    const secret = this.requireLocalSecret()
    try { return await this.bitcoin.prepareSend(secret, address, parseBtcAmount(amount)) }
    finally { secret.fill(0) }
  }

  async confirmBitcoinSend(token: string): Promise<{ txid: string }> {
    this.requireLocalSecret().fill(0)
    return this.bitcoin.confirmSend(token)
  }

  settings(): { esploraUrl: string; privacyNotice: string } {
    return {
      esploraUrl: this.prefs.esploraUrl,
      privacyNotice: 'The Esplora service can see the Bitcoin address you query and your network address. NCC routes it through Tor when Tor is enabled.'
    }
  }

  async loadMoneroRecord(): Promise<MoneroWalletRecord | null> {
    const local = this.readMoneroCiphertext()
    if (local) return this.decryptMoneroRecord(local)
    const secret = this.requireLocalSecret()
    try {
      const pubkey = getPublicKey(secret)
      const relays = await (this.relays?.() ?? [])
      if (!this.relayPool || !relays.length) return null
      const events = await this.relayPool.query(relays, { kinds: [30078], authors: [pubkey], '#d': [MONERO_D_TAG] })
      const latest = events.filter((event) => event.kind === 30078 && event.pubkey === pubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1] === MONERO_D_TAG)).sort((a, b) => b.created_at - a.created_at)[0]
      if (!latest) return null
      this.writeMoneroCiphertext(latest.content)
      return this.decryptMoneroRecord(latest.content)
    } finally { secret.fill(0) }
  }

  async saveMoneroRecord(record: MoneroWalletRecord): Promise<void> {
    if (record.version !== 1 || !record.seed.trim() || !record.address || !Number.isSafeInteger(record.restoreHeight) || record.restoreHeight < 0) {
      throw new Error('Invalid Monero wallet record')
    }
    const secret = this.requireLocalSecret()
    try {
      const pubkey = getPublicKey(secret)
      const ciphertext = encryptNip44(secret, pubkey, JSON.stringify(record))
      this.writeMoneroCiphertext(ciphertext)
      if (record.syncChoice === 'encrypted-relay') {
        const relays = await (this.relays?.() ?? [])
        if (!this.relayPool || !relays.length) throw new Error('No relays are configured for encrypted wallet sync')
        const previous = await this.relayPool.query(relays, { kinds: [30078], authors: [pubkey], '#d': [MONERO_D_TAG] }).catch(() => [])
        const timestamp = Math.max(Math.floor(Date.now() / 1000), ...previous.map((event) => event.created_at + 1))
        const event = finalizeEvent({ kind: 30078, created_at: timestamp, tags: [['d', MONERO_D_TAG]], content: ciphertext }, secret) as Event
        await this.relayPool.publishMany(relays, event)
      }
    } finally { secret.fill(0) }
  }

  async deleteMoneroRecord(): Promise<void> {
    const secret = this.requireLocalSecret()
    try {
      const pubkey = getPublicKey(secret)
      const relays = await (this.relays?.() ?? [])
      if (this.relayPool && relays.length) {
        const events = await this.relayPool.query(relays, { kinds: [30078], authors: [pubkey], '#d': [MONERO_D_TAG] })
        if (events.length) {
          const deletion = finalizeEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [...events.map((event) => ['e', event.id]), ['a', `30078:${pubkey}:${MONERO_D_TAG}`]], content: '' }, secret) as Event
          await this.relayPool.publishMany(relays, deletion)
        }
      }
      if (this.moneroPath && existsSync(this.moneroPath)) unlinkSync(this.moneroPath)
    } finally { secret.fill(0) }
  }

  setSettings(input: { esploraUrl?: string }): { esploraUrl: string; privacyNotice: string } {
    const nextUrl = input.esploraUrl?.trim() || DEFAULT_ESPLORA_URL
    const replacement = new BitcoinWallet(nextUrl, this.torProxy, Date.now, this.requester)
    this.bitcoin.clear()
    this.bitcoin = replacement
    this.prefs = { version: 1, esploraUrl: nextUrl }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.prefs, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.filePath)
    return this.settings()
  }

  dispose(): void { this.bitcoin.clear() }

  private makeBitcoin(): BitcoinWallet {
    return new BitcoinWallet(this.prefs.esploraUrl, this.torProxy, Date.now, this.requester)
  }

  private requireLocalSecret(): Uint8Array {
    const status = this.identity.status()
    const secret = status.mode === 'local' && status.configured ? this.identity.activeLocalSecret() : null
    if (!secret) throw new Error('Unlock a local Nostr identity to use the Bitcoin wallet')
    return new Uint8Array(secret)
  }

  private readPrefs(): WalletPrefs {
    try {
      if (!existsSync(this.filePath)) return { version: 1, esploraUrl: DEFAULT_ESPLORA_URL }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<WalletPrefs>
      if (parsed.version === 1 && typeof parsed.esploraUrl === 'string') {
        // Constructor validates the saved URL before any request can use it.
        new BitcoinWallet(parsed.esploraUrl)
        return { version: 1, esploraUrl: parsed.esploraUrl }
      }
    } catch { /* A corrupt preference falls back to the safe public default. */ }
    return { version: 1, esploraUrl: DEFAULT_ESPLORA_URL }
  }

  private decryptMoneroRecord(ciphertext: string): MoneroWalletRecord {
    const secret = this.requireLocalSecret()
    try {
      const plaintext = decryptNip44(secret, getPublicKey(secret), ciphertext)
      const record = JSON.parse(plaintext) as Partial<MoneroWalletRecord>
      if (record.version !== 1 || typeof record.seed !== 'string' || typeof record.address !== 'string' || !Number.isSafeInteger(record.restoreHeight) || (record.syncChoice !== 'local' && record.syncChoice !== 'encrypted-relay')) throw new Error('Stored Monero wallet record is invalid')
      return record as MoneroWalletRecord
    } finally { secret.fill(0) }
  }

  private readMoneroCiphertext(): string | null {
    if (!this.moneroPath || !existsSync(this.moneroPath)) return null
    try {
      const data = JSON.parse(readFileSync(this.moneroPath, 'utf8')) as { version?: number; ciphertext?: string }
      return data.version === 1 && typeof data.ciphertext === 'string' ? data.ciphertext : null
    } catch { return null }
  }

  private writeMoneroCiphertext(ciphertext: string): void {
    if (!this.moneroPath) throw new Error('Local Monero storage is unavailable')
    mkdirSync(dirname(this.moneroPath), { recursive: true })
    const tmp = `${this.moneroPath}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, ciphertext })}\n`, { mode: 0o600 })
    renameSync(tmp, this.moneroPath)
  }
}
