import { describe, expect, it } from 'vitest'
import { restoredTabPlan, savedWindowSession } from '../src/main/shell/session'

describe('savedWindowSession', () => {
  it('persists normal tabs only and records the active one', () => {
    const saved = savedWindowSession(
      [
        { id: 't1', kind: 'normal', mode: 'ncc', displayUrl: 'ncc://npub1abc/web' },
        { id: 't2', kind: 'private', mode: 'web', displayUrl: 'https://private.example' },
        { id: 't3', kind: 'tor', mode: 'web', displayUrl: 'https://onion.example' },
        { id: 't4', kind: 'normal', mode: 'blank', displayUrl: 'https://stale.example' }
      ],
      't1',
      { width: 1200, height: 800, x: 10, y: 20 },
      true
    )

    expect(saved.tabs).toEqual([{ url: 'ncc://npub1abc/web' }, { url: '' }])
    expect(saved.activeIndex).toBe(0)
    expect(saved.window).toEqual({ width: 1200, height: 800, x: 10, y: 20, maximized: true })
  })

  it('keeps one blank tab when only private tabs were open', () => {
    const saved = savedWindowSession(
      [{ id: 't1', kind: 'private', mode: 'web', displayUrl: 'https://private.example' }],
      't1',
      { width: 900, height: 600 },
      false
    )
    expect(saved.tabs).toEqual([{ url: '' }])
    expect(saved.activeIndex).toBe(0)
  })
})

describe('restoredTabPlan', () => {
  it('restores a saved list and clamps an out-of-range active index', () => {
    const plan = restoredTabPlan({
      version: 1,
      savedAt: 0,
      tabs: [{ url: 'ncc://npub1abc/web' }, { url: '' }],
      activeIndex: 9,
      window: { width: 1280, height: 860, maximized: false }
    })
    expect(plan.tabs).toHaveLength(2)
    expect(plan.activeIndex).toBe(1)
  })

  it('falls back to one blank tab for a fresh launch', () => {
    expect(restoredTabPlan(null)).toEqual({ tabs: [{ url: '' }], activeIndex: 0 })
  })
})
