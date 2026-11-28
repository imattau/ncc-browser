import { describe, expect, it } from 'vitest'
import { isEmptyTab, savedWindowSession } from '../src/main/shell/session'

const bounds = { width: 900, height: 600 }

describe('restored tabs that have not loaded yet', () => {
  it('keeps their addresses when the session is saved again', () => {
    const saved = savedWindowSession(
      [
        { id: 't1', kind: 'normal', mode: 'web', displayUrl: 'https://active.example' },
        {
          id: 't2',
          kind: 'normal',
          mode: 'blank',
          displayUrl: 'https://waiting.example',
          pendingUrl: 'https://waiting.example'
        },
        { id: 't3', kind: 'normal', mode: 'blank', displayUrl: '' }
      ],
      't1',
      bounds,
      false
    )
    expect(saved.tabs).toEqual([
      { url: 'https://active.example' },
      { url: 'https://waiting.example' },
      { url: '' }
    ])
  })

  it('are not treated as empty', () => {
    expect(isEmptyTab({ mode: 'blank', pendingUrl: 'https://waiting.example' })).toBe(false)
    expect(isEmptyTab({ mode: 'blank', pendingUrl: null })).toBe(true)
    expect(isEmptyTab({ mode: 'web' })).toBe(false)
  })
})
