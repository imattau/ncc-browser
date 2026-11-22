import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  certificateInfo,
  generateSelfSignedCertificate,
  saveCertificateFiles
} from '../src/main/hosting/certificates'
import { certificateCoversHost } from '../src/shared/hosting'

describe('TLS certificates', () => {
  it('generates a self-signed certificate with SANs and a stable pin', async () => {
    const generated = await generateSelfSignedCertificate({
      commonName: '127.0.0.1',
      altNames: ['localhost', '192.168.1.20', '2001:db8::20'],
      days: 30
    })

    expect(generated.key).toContain('BEGIN PRIVATE KEY')
    expect(generated.cert).toContain('BEGIN CERTIFICATE')
    expect(generated.info.names).toEqual(
      expect.arrayContaining(['localhost', '192.168.1.20', '2001:db8::20'])
    )
    expect(generated.info.pin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generated.info.validTo).toBeTruthy()

    const reread = certificateInfo(generated.cert)
    expect(reread?.pin).toBe(generated.info.pin)
    expect(reread?.names).toEqual(expect.arrayContaining(['localhost', '192.168.1.20']))
  })

  it('saves the certificate and a 0600 private key', async () => {
    const generated = await generateSelfSignedCertificate({
      commonName: 'localhost',
      altNames: ['127.0.0.1'],
      days: 1
    })
    const directory = mkdtempSync(join(tmpdir(), 'ncc-certificate-'))
    const paths = saveCertificateFiles(directory, 'my service', generated.cert, generated.key)
    expect(paths.certPath).toContain('my-service-cert.pem')
    expect(paths.keyPath).toContain('my-service-key.pem')
    expect(readFileSync(paths.certPath, 'utf8')).toContain('BEGIN CERTIFICATE')
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600)
  })

  it('matches hosts, IPs and wildcard SANs', () => {
    const info = {
      names: ['example.com', '*.example.com', '192.168.1.20', '2001:db8::20']
    }
    expect(certificateCoversHost(info, 'example.com')).toBe(true)
    expect(certificateCoversHost(info, 'www.example.com')).toBe(true)
    expect(certificateCoversHost(info, 'a.b.example.com')).toBe(false)
    expect(certificateCoversHost(info, '192.168.1.20')).toBe(true)
    expect(certificateCoversHost(info, '192.168.1.21')).toBe(false)
    expect(certificateCoversHost(info, '[2001:db8::20]')).toBe(true)
  })
})
