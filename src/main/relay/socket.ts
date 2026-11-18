/**
 * TLS pinning for Nostr relay connections.
 *
 * Relay sockets are opened by `ws` in the main process, so Chromium's
 * `setCertificateVerifyProc` (used for `ncc://` pages) never sees them. NCC-05 lets
 * a locator publish an SPKI fingerprint (`k`); this module enforces it the same way
 * the content session does: DANE-style, accepting a self-signed certificate only
 * when its fingerprint matches, and rejecting expired or mismatched certificates.
 *
 * Pins are keyed by `host:port`, not hostname, because one host can serve several
 * pinned relays on different ports.
 */

import { X509Certificate } from 'node:crypto'
import type { Agent } from 'node:http'
import type { TLSSocket } from 'node:tls'
import WebSocket, { type ClientOptions } from 'ws'

import type { RelayEntry } from '@shared/types'
import { constantTimeEqual, isUsableFingerprint } from '../pins'

export type RelayPinFailure = 'pin-mismatch' | 'expired-cert' | 'unreadable-cert'

/** `host:port` for a `wss:` URL; null for anything else (there is no TLS to pin). */
export function relayPinKey(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'wss:') return null
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '443'}`
}

/** base64url(sha256(SPKI DER)) for a DER-encoded certificate. */
export function spkiFingerprintFromDer(der: Buffer | Uint8Array): string | null {
  try {
    const certificate = new X509Certificate(Buffer.from(der))
    const spki = certificate.publicKey.export({ type: 'spki', format: 'der' })
    return Buffer.from(spki).toString('base64url')
  } catch {
    return null
  }
}

export interface RelayPinFailureRecord {
  reason: RelayPinFailure
  at: number
}

export class RelayPinStore {
  private readonly pins = new Map<string, string>()
  private readonly failures = new Map<string, RelayPinFailureRecord>()

  /** Register the pin for an entry, replacing any previous pin for its endpoint. */
  setForEntry(entry: RelayEntry): void {
    const key = relayPinKey(entry.url)
    if (!key) return
    const k = entry.locator?.k
    if (k && isUsableFingerprint(k)) this.pins.set(key, k)
    else this.pins.delete(key)
  }

  setFromEntries(entries: readonly RelayEntry[]): void {
    this.pins.clear()
    for (const entry of entries) this.setForEntry(entry)
  }

  get(url: string): string | undefined {
    const key = relayPinKey(url)
    return key ? this.pins.get(key) : undefined
  }

  clearUrl(url: string): void {
    const key = relayPinKey(url)
    if (!key) return
    this.pins.delete(key)
    this.failures.delete(key)
  }

  clear(): void {
    this.pins.clear()
    this.failures.clear()
  }

  size(): number {
    return this.pins.size
  }

  recordFailure(url: string, reason: RelayPinFailure, at = Date.now()): void {
    const key = relayPinKey(url)
    if (!key) return
    this.failures.set(key, { reason, at })
  }

  /** Read and clear the last failure, so a stale reason is never shown twice. */
  consumeFailure(url: string, maxAgeMs = 30_000): RelayPinFailure | undefined {
    const key = relayPinKey(url)
    if (!key) return undefined
    const failure = this.failures.get(key)
    this.failures.delete(key)
    if (!failure || Date.now() - failure.at > maxAgeMs) return undefined
    return failure.reason
  }
}

export interface RelaySocketFactoryOptions {
  pins: RelayPinStore
  /** SOCKS agent for `.onion` hosts; undefined for a direct connection. */
  agentFor?: (url: string) => Agent | undefined
}

/**
 * Build a `ws` implementation that honours the pin store. `SimplePool` and other
 * pools take a `websocketImplementation`, so this is the only integration point.
 */
export function createRelayWebSocket(
  options: RelaySocketFactoryOptions
): typeof WebSocket {
  class RelayWebSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[], extra?: ClientOptions) {
      const pin = options.pins.get(address)
      const agent = options.agentFor?.(address)
      const merged: ClientOptions = { ...extra }
      if (agent) merged.agent = agent
      // A pinned host may legitimately present a self-signed certificate. The
      // fingerprint, not the CA chain, is the trust anchor in that case.
      if (pin) merged.rejectUnauthorized = false

      super(address, protocols ?? [], merged)

      // Closing a socket that is still connecting makes `ws` emit an async 'error'
      // ("closed before the connection was established"). With no listener left,
      // that surfaces as an uncaught main-process exception, so keep one attached.
      this.on('error', () => undefined)

      if (!pin) return

      this.once('upgrade', (response) => {
        const socket = response.socket as TLSSocket
        const failure = verifyPin(socket, pin)
        if (!failure) return
        options.pins.recordFailure(address, failure)
        socket.destroy()
        this.terminate()
      })
    }
  }

  return RelayWebSocket as unknown as typeof WebSocket
}

function verifyPin(socket: TLSSocket, pin: string): RelayPinFailure | null {
  let certificate: ReturnType<TLSSocket['getPeerCertificate']>
  try {
    certificate = socket.getPeerCertificate()
  } catch {
    return 'unreadable-cert'
  }
  if (!certificate || !certificate.raw) return 'unreadable-cert'

  if (certificate.valid_to && Date.parse(certificate.valid_to) < Date.now()) {
    return 'expired-cert'
  }

  const actual = spkiFingerprintFromDer(certificate.raw)
  if (!actual) return 'unreadable-cert'
  return constantTimeEqual(actual, pin) ? null : 'pin-mismatch'
}
