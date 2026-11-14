/**
 * Persistence for a NIP-46 session: the remote pubkey, its relays, the optional
 * connect secret, and the client key used to encrypt the RPC channel. The client key
 * is encrypted with the same OS-keychain codec as a local identity.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IdentityCodec } from './identity'
import type { BunkerTarget } from './nip46'

export interface Nip46Session {
  target: BunkerTarget
  /** Hex-encoded client secret. */
  clientSecret: string
  createdAt: number
}

interface SessionFile {
  version: 1
  remotePubkey: string
  relays: string[]
  secret?: string
  clientSecretCiphertext: string
  createdAt: number
}

export class Nip46SessionStore {
  constructor(
    private readonly filePath: string,
    private readonly codec: IdentityCodec,
    private readonly now: () => number = () => Date.now()
  ) {}

  load(): Promise<Nip46Session | null> {
    return this.loadAsync()
  }

  private async loadAsync(): Promise<Nip46Session | null> {
    if (!this.codec.available) return null
    try {
      if (!existsSync(this.filePath)) return null
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SessionFile>
      if (parsed.version !== 1) return null
      if (typeof parsed.remotePubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.remotePubkey)) {
        return null
      }
      if (!Array.isArray(parsed.relays) || parsed.relays.length === 0) return null
      if (typeof parsed.clientSecretCiphertext !== 'string') return null

      const relays = parsed.relays.filter(
        (relay): relay is string => typeof relay === 'string' && /^wss?:\/\//.test(relay)
      )
      if (relays.length === 0) return null

      const clientSecret = await this.codec.decrypt(parsed.clientSecretCiphertext)
      return {
        target: {
          remotePubkey: parsed.remotePubkey.toLowerCase(),
          relays,
          secret: typeof parsed.secret === 'string' ? parsed.secret : undefined
        },
        clientSecret,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : this.now()
      }
    } catch (error) {
      console.warn('[nip46] could not load saved session:', error)
      return null
    }
  }

  /** Returns false when no secure storage exists, in which case the session is ephemeral. */
  async save(session: Nip46Session): Promise<boolean> {
    if (!this.codec.available) return false
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const payload: SessionFile = {
        version: 1,
        remotePubkey: session.target.remotePubkey,
        relays: session.target.relays,
        secret: session.target.secret,
        clientSecretCiphertext: await this.codec.encrypt(session.clientSecret),
        createdAt: session.createdAt
      }
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.filePath)
      return true
    } catch (error) {
      console.warn('[nip46] could not save session:', error)
      return false
    }
  }

  clear(): void {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
    } catch (error) {
      console.warn('[nip46] could not remove saved session:', error)
    }
  }
}
