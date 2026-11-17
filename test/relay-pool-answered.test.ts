import { describe, expect, it } from 'vitest'
import { countAnswered } from '../src/main/relay/pool'

describe('countAnswered', () => {
  it('counts only relays that reached the end of their events', () => {
    expect(
      countAnswered([
        { url: 'wss://a', reason: 'closed automatically on eose' },
        { url: 'wss://b', reason: 'relay connection failed' },
        { url: 'wss://c', reason: 'connection timed out' }
      ])
    ).toBe(1)
  })

  it('treats nothing or a malformed value as no answers', () => {
    expect(countAnswered([])).toBe(0)
    expect(countAnswered(undefined)).toBe(0)
    expect(countAnswered(['relay connection failed'])).toBe(0)
  })
})
