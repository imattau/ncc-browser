import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey } from 'nostr-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WalletService } from '../src/main/wallet/service'

describe('the desktop Monero scan cache', () => {
  let directory: string
  let secret = generateSecretKey()
  const identity = {
    status: () => ({ mode: 'local', configured: true }),
    activeLocalSecret: () => secret
  }
  const service = () => new WalletService(join(directory, 'wallet.json'), {} as never, identity as never, undefined, undefined, join(directory, 'monero-wallet.json'))
  const cachePath = () => join(directory, 'monero-wallet-cache.json')
  // Larger than NIP-44 can encrypt in one piece.
  const data = { keysData: 'a2V5cw==', cacheData: 'QUJDRA=='.repeat(40_000) }

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ncc-xmr-')); secret = generateSecretKey() })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('is kept encrypted, readable only by its owner', () => {
    service().saveMoneroCache(data)
    expect(service().loadMoneroCache()).toEqual(data)
    expect(readFileSync(cachePath(), 'utf8')).not.toContain('QUJDRA')
    if (process.platform !== 'win32') expect(statSync(cachePath()).mode & 0o777).toBe(0o600)
  })

  it('is ignored when missing, damaged or written by another identity', () => {
    expect(service().loadMoneroCache()).toBeNull()
    service().saveMoneroCache(data)
    secret = generateSecretKey()
    expect(service().loadMoneroCache()).toBeNull()
    writeFileSync(cachePath(), 'not json')
    expect(service().loadMoneroCache()).toBeNull()
  })

  it('refuses an incomplete cache', () => {
    expect(() => service().saveMoneroCache({ keysData: 'a', cacheData: '' })).toThrow(/incomplete/)
  })
})
