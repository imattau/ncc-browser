import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  durationFromNow,
  messageOf,
  relativeSeconds,
  shortIdentity,
  untilSeconds
} from '../src/renderer/src/lib/format'

const NOW = 1_700_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('messageOf', () => {
  it('unwraps the Electron remote-invocation prefix', () => {
    const error = new Error("Error invoking remote method 'ncc:get-config': Error: no window")
    expect(messageOf(error)).toBe('no window')
  })

  it('keeps the innermost message when several are nested', () => {
    expect(messageOf(new Error('Error: outer: Error: inner'))).toBe('inner')
  })

  it('passes a plain message through', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('raw string')).toBe('raw string')
  })
})

describe('relativeSeconds', () => {
  it('reports an unpublished record', () => {
    expect(relativeSeconds(undefined)).toBe('not published')
    expect(relativeSeconds(0)).toBe('not published')
  })

  it('clamps a future timestamp to just now', () => {
    expect(relativeSeconds(NOW + 600)).toBe('just now')
  })

  it('changes unit at each boundary', () => {
    expect(relativeSeconds(NOW - 30)).toBe('just now')
    expect(relativeSeconds(NOW - 60)).toBe('1 min ago')
    expect(relativeSeconds(NOW - 3599)).toBe('59 min ago')
    expect(relativeSeconds(NOW - 3600)).toBe('1 h ago')
    expect(relativeSeconds(NOW - 86_399)).toBe('23 h ago')
    expect(relativeSeconds(NOW - 86_400)).toBe('1 d ago')
  })
})

describe('untilSeconds', () => {
  it('reports an expired timestamp', () => {
    expect(untilSeconds(NOW)).toBe('expired')
    expect(untilSeconds(NOW - 1)).toBe('expired')
  })

  it('rounds up to at least one minute', () => {
    expect(untilSeconds(NOW + 1)).toBe('1 min left')
    expect(untilSeconds(NOW + 120)).toBe('2 min left')
  })

  it('changes unit at each boundary', () => {
    expect(untilSeconds(NOW + 3599)).toBe('60 min left')
    expect(untilSeconds(NOW + 3600)).toBe('1 h left')
    expect(untilSeconds(NOW + 86_399)).toBe('24 h left')
    expect(untilSeconds(NOW + 86_400)).toBe('1 d left')
  })
})

describe('durationFromNow', () => {
  it('uses the compact form', () => {
    expect(durationFromNow(NOW)).toBe('expired')
    expect(durationFromNow(NOW + 120)).toBe('2 min')
    expect(durationFromNow(NOW + 3600)).toBe('1 h')
    expect(durationFromNow(NOW + 86_400)).toBe('1 d')
  })
})

describe('shortIdentity', () => {
  const npub = 'npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q'

  it('keeps the default head and tail widths', () => {
    expect(shortIdentity(npub)).toBe(`${npub.slice(0, 12)}…${npub.slice(-6)}`)
    expect(shortIdentity(npub)).toHaveLength(19)
  })

  it('honours call-site widths', () => {
    expect(shortIdentity(npub, 16, 6)).toBe(`${npub.slice(0, 16)}…${npub.slice(-6)}`)
  })

  it('leaves short values alone and trims whitespace', () => {
    expect(shortIdentity('alice')).toBe('alice')
    expect(shortIdentity('  alice  ')).toBe('alice')
  })
})
