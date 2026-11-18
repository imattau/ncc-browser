import { describe, expect, it, vi } from 'vitest'
import { createSecurity } from '../mobile/security.js'

describe('mobile security state', () => {
  it('classifies the available endpoint and address information', () => {
    const security = createSecurity({ getProxyPort: () => 8080 })
    expect(security.classifySecurity({ endpoints: [{ protocol: 'https', pinned: true }] })).toBe('pinned')
    expect(security.classifySecurity({ kind: 'nsite' })).toBe('verified')
    expect(security.classifySecurity({ kind: 'clearnet', secure: false })).toBe('plain')
    expect(security.classifySecurity({ error: 'missing' })).toBe('unknown')
  })

  it('recognizes clearnet and onion addresses without a proxy request', async () => {
    const security = createSecurity({ getProxyPort: () => 0 })
    expect(await security.securityFor('https://example.com')).toBe('tls')
    expect(await security.securityFor('http://example.com')).toBe('plain')
    expect(await security.securityFor('http://abc.onion.localhost:9050/')).toBe('onion')
  })

  it('uses the current proxy port and caches service classifications', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ endpoints: [{ protocol: 'https' }] })
    } as Response)
    const security = createSecurity({ getProxyPort: () => 8765 })
    expect(await security.securityFor('http://pubkey.web.localhost:8765/')).toBe('tls')
    expect(await security.securityFor('http://pubkey.web.localhost:8765/')).toBe('tls')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain(':8765/')
    fetchSpy.mockRestore()
  })
})
