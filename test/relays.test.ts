import { describe, expect, it } from 'vitest'
import { normalizeRelays } from '../src/shared/relays'

describe('normalizeRelays', () => {
  it('accepts ws and wss and strips trailing slashes', () => {
    expect(normalizeRelays(['wss://relay.example/', 'ws://127.0.0.1:7777'])).toEqual([
      'wss://relay.example',
      'ws://127.0.0.1:7777'
    ])
  })

  it('deduplicates and skips blanks', () => {
    expect(normalizeRelays(['wss://a.example', ' wss://a.example ', '', null])).toEqual([
      'wss://a.example'
    ])
  })

  it('rejects non-websocket URLs', () => {
    expect(() => normalizeRelays(['https://relay.example'])).toThrow(/ws/)
    expect(() => normalizeRelays(['not a url'])).toThrow(/valid relay URL/)
    expect(() => normalizeRelays(['wss://relay.example/#frag'])).toThrow(/fragment/)
  })

  it('requires at least one relay', () => {
    expect(() => normalizeRelays([])).toThrow(/At least one relay/)
    expect(() => normalizeRelays('wss://relay.example')).toThrow(/array/)
  })
})
