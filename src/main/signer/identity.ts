/**
 * Identity storage. The secret key never leaves the main process; it is encrypted with
 * Electron's `safeStorage` (OS keychain) when that is available and kept in memory
 * otherwise. Encryption is async because Electron 45 deprecated the synchronous API.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import type { IdentityStatus } from '@shared/types'
import type { LocatorSigner } from '../ncc/resolver'
import {
  hexPubkeyOf,
  npubOf,
  parseSecretKey,
  secretKeyToHex,
  SignerError
} from './crypto'

interface IdentityFile {
  version: 1
  ciphertext: string
  createdAt: number
}

export interface IdentityCodec {
  /** Whether the OS can protect the key at rest. */
  available: boolean
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
}

export interface IdentityStoreOptions {
  filePath: string
  codec: IdentityCodec
  now?: () => number
}

export class IdentityStore {
  private secret: Uint8Array | null = null
  private source: IdentityStatus['source'] = 'none'
  private persisted = false
  private readonly options: IdentityStoreOptions
  private readonly now: () => number
  private loaded = false

  constructor(options: IdentityStoreOptions) {
    this.options = options
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** Read and decrypt the stored key, if any. */
  static async open(options: IdentityStoreOptions): Promise<IdentityStore> {
    const store = new IdentityStore(options)
    await store.load()
    return store
  }

  status(): IdentityStatus {
    const configured = this.secret !== null
    return {
      configured,
      mode: configured ? 'local' : 'none',
      npub: configured ? npubOf(this.secret as Uint8Array) : undefined,
      hexPubkey: configured ? hexPubkeyOf(this.secret as Uint8Array) : undefined,
      source: this.source,
      persisted: this.persisted,
      encryptionAvailable: this.options.codec.available
    }
  }

  getSecret(): Uint8Array | null {
    return this.secret
  }

  /** Used by tests and by the local provider; NIP-46 does not expose a key. */
  getSigner(): LocatorSigner | null {
    const secret = this.secret
    if (!secret) return null
    return {
      getPublicKey: () => getPublicKey(secret),
      getConversationKey: (peer: string) => nip44.getConversationKey(secret, peer)
    }
  }

  async import(input: string): Promise<IdentityStatus> {
    const secret = parseSecretKey(input)
    this.secret = secret
    await this.persist()
    return this.status()
  }

  async generate(): Promise<IdentityStatus> {
    this.secret = generateSecretKey()
    await this.persist()
    return this.status()
  }

  /** Development/e2e override: takes precedence over the stored identity. */
  setFromEnv(input: string): IdentityStatus {
    const secret = parseSecretKey(input)
    this.secret = secret
    this.source = 'env'
    this.persisted = false
    return this.status()
  }

  remove(): IdentityStatus {
    this.secret = null
    this.source = 'none'
    this.persisted = false
    try {
      if (existsSync(this.options.filePath)) unlinkSync(this.options.filePath)
    } catch (error) {
      console.warn('[identity] could not remove stored key:', error)
    }
    return this.status()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.options.codec.available) return

    try {
      if (!existsSync(this.options.filePath)) return
      const parsed = JSON.parse(readFileSync(this.options.filePath, 'utf8')) as Partial<IdentityFile>
      if (parsed.version !== 1 || typeof parsed.ciphertext !== 'string') return

      const hex = await this.options.codec.decrypt(parsed.ciphertext)
      this.secret = parseSecretKey(hex)
      this.source = 'file'
      this.persisted = true
    } catch (error) {
      console.warn('[identity] could not load stored key:', error)
    }
  }

  private async persist(): Promise<void> {
    if (!this.secret) return

    if (!this.options.codec.available) {
      // No OS keychain: keep the identity for this session only.
      this.source = 'session'
      this.persisted = false
      return
    }

    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true })
      const payload: IdentityFile = {
        version: 1,
        ciphertext: await this.options.codec.encrypt(secretKeyToHex(this.secret)),
        createdAt: this.now()
      }
      const tmp = `${this.options.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.options.filePath)
      this.source = 'file'
      this.persisted = true
    } catch (error) {
      this.source = 'session'
      this.persisted = false
      throw new SignerError(
        `Could not store the key securely: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
