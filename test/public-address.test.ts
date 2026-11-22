import { describe, expect, it, vi } from 'vitest'
import {
  PublicAddressService,
  addressFamily,
  parsePublicAddress
} from '../src/main/hosting/public-address'

function response(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('public address parsing', () => {
  it('accepts JSON and plain text providers', () => {
    expect(parsePublicAddress('{"ip":"203.0.113.42"}', 'p', 1)).toEqual({
      address: '203.0.113.42',
      family: 'ipv4',
      provider: 'p',
      checkedAt: 1
    })
    expect(parsePublicAddress('2001:db8::1\n', 'p', 2)?.family).toBe('ipv6')
    expect(parsePublicAddress('not an address', 'p', 3)).toBeNull()
    expect(parsePublicAddress('{"nope":true}', 'p', 4)).toBeNull()
    expect(addressFamily('192.168.1.1')).toBe('ipv4')
    expect(addressFamily('fd00::1')).toBe('ipv6')
    expect(addressFamily('nope')).toBeNull()
  })
})

describe('PublicAddressService', () => {
  it('caches the lookup and can force a refresh', async () => {
    let now = 1_000
    const fetchImpl = vi.fn(async () => response('{"ip":"203.0.113.42"}'))
    const service = new PublicAddressService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now
    })

    expect(await service.lookup()).toMatchObject({ address: '203.0.113.42', family: 'ipv4' })
    await service.lookup()
    expect(fetchImpl).toHaveBeenCalledOnce()

    now += 11 * 60_000
    await service.lookup()
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    await service.lookup(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(service.existing()).not.toBeNull()
    service.clear()
    expect(service.existing()).toBeNull()
  })

  it('fails clearly when the provider errors or returns junk', async () => {
    const bad = new PublicAddressService({
      fetchImpl: (async () => response('down', 503)) as unknown as typeof fetch
    })
    await expect(bad.lookup()).rejects.toThrow('HTTP 503')

    const junk = new PublicAddressService({
      fetchImpl: (async () => response('nope')) as unknown as typeof fetch
    })
    await expect(junk.lookup()).rejects.toThrow('no address')
  })

  it('sends no credentials and uses the disclosed provider', async () => {
    let requested = ''
    const service = new PublicAddressService({
      fetchImpl: (async (url: string) => {
        requested = url
        return response('{"ip":"198.51.100.7"}')
      }) as unknown as typeof fetch
    })
    await service.lookup()
    expect(requested).toBe('https://api64.ipify.org?format=json')
  })
})
