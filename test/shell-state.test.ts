import { describe, expect, it } from 'vitest'
import { buildNavState } from '../src/main/shell/state'

const base = {
  tabs: [],
  activeTabId: null,
  preferTor: false,
  windowMaximized: false,
  banner: null,
  insecurePrompt: null
}

describe('buildNavState', () => {
  it('describes an empty window as a blank normal tab', () => {
    const state = buildNavState({ ...base, active: null })
    expect(state).toMatchObject({
      mode: 'blank',
      displayUrl: '',
      tabKind: 'normal',
      activeTabId: null,
      tor: { preferTor: false, onionAvailable: false, active: false, tabTor: false }
    })
  })

  it('marks a Tor tab and keeps its history flags', () => {
    const state = buildNavState({
      ...base,
      active: {
        mode: 'ncc',
        displayUrl: 'ncc://npub1abc/web',
        url: 'ncc://npub1abc/web/',
        title: 'Example',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        security: null,
        failure: null,
        tor: { onionAvailable: true, active: true },
        kind: 'tor'
      },
      preferTor: true,
      activeTabId: 't1',
      windowMaximized: true
    })
    expect(state.tabKind).toBe('tor')
    expect(state.tor).toEqual({
      preferTor: true,
      onionAvailable: true,
      active: true,
      tabTor: true
    })
    expect(state.canGoBack).toBe(true)
    expect(state.windowMaximized).toBe(true)
  })
})
