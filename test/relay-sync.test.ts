import { describe, expect, it, vi } from 'vitest'
import { RelaySync } from '../src/main/relay/sync'
import type { RelayEntry } from '../src/shared/types'

const NOW = 1_800_000_000

function locatorEntry(overrides: Partial<RelayEntry> = {}): RelayEntry {
  return {
    url: 'wss://old.example/',
    locator: {
      identity: 'npub1example',
      pubkey: 'a'.repeat(64),
      service: 'relay',
      dTag: 'relay',
      expiresAt: NOW + 30,
      k: null
    },
    ...overrides
  }
}

describe('RelaySync', () => {
  it('refreshes a locator only when it is inside the jitter window', async () => {
    const refresh = vi.fn(async (entry: RelayEntry) => entry)
    const apply = vi.fn()
    const sync = new RelaySync({
      entries: () => [locatorEntry({ locator: { ...locatorEntry().locator!, expiresAt: NOW + 600 } })],
      refresh,
      apply,
      markStale: vi.fn(),
      now: () => NOW,
      jitterSeconds: () => 60
    })

    await sync.tick()
    expect(refresh).not.toHaveBeenCalled()

    const due = new RelaySync({
      entries: () => [locatorEntry()],
      refresh,
      apply,
      markStale: vi.fn(),
      now: () => NOW,
      jitterSeconds: () => 60
    })
    await due.tick()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('wss://old.example/', expect.objectContaining({ url: 'wss://old.example/' }))
  })

  it('moves the entry and clears stale when the endpoint rotated', async () => {
    const apply = vi.fn()
    const sync = new RelaySync({
      entries: () => [locatorEntry()],
      refresh: async (entry) => ({
        ...entry,
        url: 'wss://new.example/',
        locator: { ...entry.locator!, k: 'bmV3' }
      }),
      apply,
      markStale: vi.fn(),
      now: () => NOW,
      jitterSeconds: () => 60
    })

    await sync.tick()
    expect(apply).toHaveBeenCalledWith(
      'wss://old.example/',
      expect.objectContaining({
        url: 'wss://new.example/',
        stale: false,
        locator: expect.objectContaining({ k: 'bmV3' })
      })
    )
  })

  it('keeps the old endpoint and marks it stale when resolution fails', async () => {
    const apply = vi.fn()
    const markStale = vi.fn()
    const sync = new RelaySync({
      entries: () => [locatorEntry()],
      refresh: async () => null,
      apply,
      markStale,
      now: () => NOW,
      jitterSeconds: () => 60
    })

    await sync.tick()
    expect(apply).not.toHaveBeenCalled()
    expect(markStale).toHaveBeenCalledWith('wss://old.example/', true)
  })

  it('never re-resolves a direct relay', async () => {
    const refresh = vi.fn(async () => null)
    const sync = new RelaySync({
      entries: () => [{ url: 'wss://plain.example' }],
      refresh,
      apply: vi.fn(),
      markStale: vi.fn(),
      now: () => NOW,
      jitterSeconds: () => 60
    })

    await sync.tick()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('also refreshes relays held outside the config', async () => {
    const refreshExtra = vi.fn(async () => undefined)
    const sync = new RelaySync({
      entries: () => [],
      refresh: async () => null,
      apply: vi.fn(),
      markStale: vi.fn(),
      refreshExtra,
      now: () => NOW
    })

    await sync.tick()
    expect(refreshExtra).toHaveBeenCalledTimes(1)
  })
})
