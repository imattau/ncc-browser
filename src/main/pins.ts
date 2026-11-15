import { createHash, createPublicKey } from 'node:crypto'
import type { Session } from 'electron'

export interface Pin {
  /** base64url(sha256(SPKI DER)), exactly as published in a locator's `k`. */
  k: string
  label: string
}

export interface CertRejection {
  reason: 'pin-mismatch' | 'expired-cert' | 'unreadable-cert'
  at: number
}

/**
 * Host → expected transport fingerprint. Populated at resolution time and consulted
 * by `setCertificateVerifyProc` for every request in the content session.
 */
export class PinStore {
  private readonly pins = new Map<string, Pin>()
  private readonly rejections = new Map<string, CertRejection>()

  set(hostname: string, pin: Pin): void {
    this.pins.set(hostname.toLowerCase(), pin)
  }

  get(hostname: string): Pin | undefined {
    return this.pins.get(hostname.toLowerCase())
  }

  clearHost(hostname: string): void {
    this.pins.delete(hostname.toLowerCase())
    this.rejections.delete(hostname.toLowerCase())
  }

  clear(): void {
    this.pins.clear()
    this.rejections.clear()
  }

  size(): number {
    return this.pins.size
  }

  /**
   * Chromium reports a failed TLS verification as a generic `net::ERR_FAILED`, so the
   * verify proc records why it refused. The protocol layer consumes this immediately
   * after a failed fetch to distinguish a pin mismatch from a dead endpoint.
   */
  recordRejection(hostname: string, reason: CertRejection['reason']): void {
    this.rejections.set(hostname.toLowerCase(), { reason, at: Date.now() })
  }

  consumeRejection(hostname: string, maxAgeMs = 30_000): CertRejection | undefined {
    const key = hostname.toLowerCase()
    const rejection = this.rejections.get(key)
    this.rejections.delete(key)
    if (!rejection) return undefined
    if (Date.now() - rejection.at > maxAgeMs) return undefined
    return rejection
  }
}

export function spkiFingerprintFromPem(pem: string | Buffer): string | null {
  try {
    const publicKey = createPublicKey(pem)
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256')
      .update(spki)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  } catch {
    return null
  }
}

/**
 * DANE-style pinning: a certificate is accepted when its SPKI fingerprint matches the
 * `k` published in the locator, regardless of CA or hostname validation. Hosts with no
 * pin fall back to Chromium's normal verification.
 */
export function installCertificatePinning(session: Session, store: PinStore): void {
  session.setCertificateVerifyProc((request, callback) => {
    const pin = store.get(request.hostname)
    if (!pin) {
      callback(-3) // use Chromium's verification result
      return
    }

    // Development placeholders such as `TESTKEY:ncc06-abc` are not real fingerprints.
    if (!isUsableFingerprint(pin.k)) {
      callback(-3)
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const expiry = request.certificate?.validExpiry ?? 0
    if (expiry && expiry < now) {
      store.recordRejection(request.hostname, 'expired-cert')
      callback(-2)
      return
    }

    const actual = request.certificate?.data
      ? spkiFingerprintFromPem(request.certificate.data)
      : null
    if (!actual) {
      store.recordRejection(request.hostname, 'unreadable-cert')
      callback(-2)
      return
    }
    if (constantTimeEqual(actual, pin.k)) {
      callback(0) // pin matches: accept self-signed and hostname-mismatched certs
    } else {
      store.recordRejection(request.hostname, 'pin-mismatch')
      callback(-2)
    }
  })
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

export { constantTimeEqual }

/** Development placeholders such as `TESTKEY:ncc06-abc` are not real fingerprints. */
export function isUsableFingerprint(k: string): boolean {
  return !(k.startsWith('TESTKEY:') || k.includes(':'))
}
