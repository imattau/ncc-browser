/**
 * TLS certificate helpers for a hosted service endpoint.
 *
 * The browser does not terminate TLS for a service. It can derive the NCC-05 `k` pin
 * from an imported certificate, or generate a self-signed certificate and key for the
 * publisher to install in their own server. Only the public pin is stored with the
 * service; a generated private key is written to the folder the user picks.
 */

import { createHash, X509Certificate } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import selfsigned from 'selfsigned'
import type { CertificateInfo } from '@shared/hosting'

export function certificateInfo(input: string | Buffer): CertificateInfo | null {
  try {
    const certificate = new X509Certificate(input)
    const pin = pinOf(certificate)
    return {
      pin,
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      names: namesOf(certificate)
    }
  } catch {
    return null
  }
}

function pinOf(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256')
    .update(spki)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function namesOf(certificate: X509Certificate): string[] {
  const raw = certificate.subjectAltName ?? ''
  return raw
    .split(/,\s*/)
    .map((entry) => entry.replace(/^(DNS|IP Address|IP|email|URI):\s*/i, '').trim())
    .filter(Boolean)
    .map((name) => {
      if (isIP(name) !== 6) return name.toLowerCase()
      try {
        return new URL(`http://[${name}]/`).hostname.replace(/^\[|\]$/g, '')
      } catch {
        return name.toLowerCase()
      }
    })
}

export interface GenerateCertificateOptions {
  commonName: string
  /** Extra DNS names or IP addresses to include in subjectAltName. */
  altNames?: string[]
  days?: number
}

export async function generateSelfSignedCertificate(options: GenerateCertificateOptions): Promise<{
  cert: string
  key: string
  info: CertificateInfo
}> {
  const commonName = options.commonName.trim()
  if (!commonName) throw new Error('A common name is required')
  const names = [...new Set([commonName, ...(options.altNames ?? [])].map((name) => name.trim()).filter(Boolean))]
  const altNames = names.map((name) =>
    isIP(name) ? { type: 7 as const, ip: name } : { type: 2 as const, value: name }
  )
  const days = Math.max(1, Math.min(825, options.days ?? 365))
  const pems = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
    notAfterDate: new Date(Date.now() + days * 86_400_000),
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  })
  const info = certificateInfo(pems.cert)
  if (!info) throw new Error('The generated certificate could not be read')
  return { cert: pems.cert, key: pems.private, info }
}

export function saveCertificateFiles(
  directory: string,
  baseName: string,
  cert: string,
  key: string
): { certPath: string; keyPath: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const base = baseName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'service'
  const certPath = join(directory, `${base}-cert.pem`)
  const keyPath = join(directory, `${base}-key.pem`)
  writeFileSync(certPath, cert, { mode: 0o644 })
  writeFileSync(keyPath, key, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  return { certPath, keyPath }
}
