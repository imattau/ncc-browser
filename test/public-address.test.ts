import { describe, expect, it, vi } from 'vitest'
import {
  PublicAddressService,
  addressFamily,
  parsePublicAddress
} from '../src/main/hosting/public-address'

function reply(body: string, status = 200) {
  return async (url: string) => ({ status, headers: {}, text: body, url })
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
    const request = vi.fn(reply('{"ip":"203.0.113.42"}'))
    const service = new PublicAddressService({
      request,
      now: () => now
    })

    expect(await service.lookup()).toMatchObject({ address: '203.0.113.42', family: 'ipv4' })
    await service.lookup()
    expect(request).toHaveBeenCalledOnce()

    now += 11 * 60_000
    await service.lookup()
    expect(request).toHaveBeenCalledTimes(2)

    await service.lookup(true)
    expect(request).toHaveBeenCalledTimes(3)
    expect(service.existing()).not.toBeNull()
    service.clear()
    expect(service.existing()).toBeNull()
  })

  it('fails clearly when the provider errors or returns junk', async () => {
    const bad = new PublicAddressService({ request: reply('down', 503) })
    await expect(bad.lookup()).rejects.toThrow('HTTP 503')

    const junk = new PublicAddressService({ request: reply('nope') })
    await expect(junk.lookup()).rejects.toThrow('no address')
  })

  it('sends no credentials and uses the disclosed provider', async () => {
    let requested = ''
    const service = new PublicAddressService({
      request: async (url: string) => {
        requested = url
        return { status: 200, headers: {}, text: '{"ip":"198.51.100.7"}', url }
      }
    })
    await service.lookup()
    expect(requested).toBe('https://api64.ipify.org?format=json')
  })
})
