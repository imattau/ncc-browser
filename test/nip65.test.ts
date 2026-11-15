import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { discoverWriteRelays, extractWriteRelays } from '../src/main/relay/nip65'

function event(tags: string[][]) {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1,
    kind: 10002,
    tags,
    content: '',
    sig: 'c'.repeat(128)
  }
}

describe('NIP-65 write relays', () => {
  it('keeps write and unmarked relays, drops read-only relays', () => {
    expect(
      extractWriteRelays(
        event([
          ['r', 'wss://read.example', 'read'],
          ['r', 'wss://write.example', 'write'],
          ['r', 'wss://both.example'],
          ['r', 'ws://plain.example'],
          ['r', 'https://not-a-relay.example']
        ])
      )
    ).toEqual(['wss://write.example', 'wss://both.example', 'ws://plain.example'])
  })

  it('caps the list and ignores malformed URLs', () => {
    const tags = Array.from({ length: 12 }, (_, index) => ['r', `wss://relay${index}.example`])
    tags.push(['r', 'not a url'])
    expect(extractWriteRelays(event(tags))).toHaveLength(8)
  })

  it('uses the newest valid kind 10002 event', async () => {
    const sk = generateSecretKey()
    const sign = (tags: string[][], created_at: number) =>
      finalizeEvent({ kind: 10002, created_at, tags, content: '' }, sk)
    const older = sign([['r', 'wss://old.example']], 1)
    const newer = sign([['r', 'wss://new.example', 'write']], 2)
    const relays = await discoverWriteRelays(
      async () => [older, newer],
      newer.pubkey,
      ['wss://configured.example']
    )
    expect(relays).toEqual(['wss://new.example'])
  })
})
