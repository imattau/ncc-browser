import { describe, expect, it } from 'vitest'
import { addressParts, displayAddress, iconKey, labelFor, shortId } from '../mobile/address.js'

describe('mobile address helpers', () => {
  it('converts proxy hostnames back to user-facing addresses', () => {
    expect(displayAddress('http://pubkey.web.localhost:8080/docs?q=1')).toBe(
      'ncc://pubkey/web/docs'
    )
    expect(displayAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(displayAddress('http://abc.onion.localhost:9050/')).toBe('http://abc.onion/')
    expect(displayAddress('http://example.com.p8443.tor.localhost:9050/a')).toBe(
      'https://example.com:8443/a'
    )
  })

  it('splits NCC addresses and labels entries', () => {
    expect(addressParts('ncc://123456789012345678/web/docs')).toEqual({
      scheme: 'ncc',
      id: '12345678…5678',
      rest: '/web/docs'
    })
    expect(labelFor({ address: 'ncc://pubkey/web/docs', title: '' })).toBe('web')
    expect(labelFor({ address: 'ncc://pubkey/web', title: 'My page' })).toBe('My page')
  })

  it('keeps icons scoped to a service and shortens long identities', () => {
    expect(iconKey('ncc://pubkey/web/docs')).toBe('ncc://pubkey/web')
    expect(shortId('12345678901234567890')).toBe('12345678…7890')
  })
})
