import { describe, expect, it } from 'vitest'
import { normalizeNwcUri, parseNwcUri } from '../src/shared/nwc'

// Made-up values, not a real connection.
const pubkey = 'a1'.repeat(32)
const secret = 'b2'.repeat(32)
const query = `relay=${encodeURIComponent('wss://relay.example/v1')}&secret=${secret}&lud16=me%40example.com`
const uri = `nostr+walletconnect://${pubkey}?${query}`

describe('a pasted Nostr Wallet Connect URI', () => {
  const pasted: Record<string, string> = {
    'as it is': uri,
    'with space around it': `  ${uri}\n`,
    'in double quotes': `"${uri}"`,
    'in curly quotes': `“${uri}”`,
    'in angle brackets': `<${uri}>`,
    'in backticks': `\`${uri}\``,
    'after a label': `NWC: ${uri}`,
    'quoted at the end of a sentence': `Connection string: "${uri}".`,
    'with a full stop': `${uri}.`,
    'with invisible characters': `​${uri.slice(0, 40)}⁠­${uri.slice(40)}﻿`,
    'wrapped with spaces and line breaks': `${uri.slice(0, 35)} ${uri.slice(35, 90)}\r\n  ${uri.slice(90)}`,
    'in the older spelling': uri.replace('nostr+walletconnect:', 'nostrwalletconnect:'),
    'without slashes': uri.replace('://', ':'),
    'in capitals': uri.replace('nostr+walletconnect', 'Nostr+WalletConnect'),
    'wholly percent-encoded': encodeURIComponent(uri)
  }

  it.each(Object.entries(pasted))('is understood %s', (_name, text) => {
    const connection = parseNwcUri(text)
    expect(connection.pubkey).toBe(pubkey)
    expect(connection.relays).toEqual(['wss://relay.example/v1'])
    expect(Buffer.from(connection.secret).toString('hex')).toBe(secret)
    expect(connection.lud16).toBe('me@example.com')
  })

  it('is tidied into the form that gets saved', () => {
    expect(normalizeNwcUri(`NWC: "${uri}"`)).toBe(uri)
  })

  it('keeps an unencoded relay address', () => {
    const plain = `nostr+walletconnect://${pubkey}?relay=wss://relay.example/v1&secret=${secret}`
    expect(parseNwcUri(plain).relays).toEqual(['wss://relay.example/v1'])
  })

  it('is still checked strictly, without repeating the secret in the error', () => {
    for (const text of [
      '',
      'https://example.com',
      'me@example.com',
      uri.replace(pubkey, pubkey.slice(2)),
      uri.replace(secret, secret.slice(2)),
      uri.replace(/relay=[^&]+&/, ''),
      uri.replace(encodeURIComponent('wss://'), encodeURIComponent('https://')),
      '%E0%A4%A walletconnect%3A'
    ]) {
      let message = ''
      try { parseNwcUri(text) } catch (error) { message = (error as Error).message }
      expect(message, text).not.toBe('')
      expect(message).not.toContain(secret.slice(2))
    }
  })
})
