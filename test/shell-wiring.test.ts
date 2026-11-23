import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { wireTab } from '../src/main/shell/wiring'
import type { ShellInternals } from '../src/main/shell/internals'
import type { Tab } from '../src/main/shell/types'

function fakeContents() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    id: 1,
    session: {},
    isCurrentlyAudible: () => false,
    isAudioMuted: () => false,
    isDestroyed: () => false,
    getURL: () => '',
    getTitle: () => '',
    setWindowOpenHandler: vi.fn(),
    navigationHistory: {}
  })
}

function fakeTab(contents: ReturnType<typeof fakeContents>): Tab {
  return {
    owner: { window: null } as unknown as Tab['owner'],
    id: 't1',
    kind: 'normal',
    view: { webContents: contents } as unknown as Tab['view'],
    mode: 'web',
    displayUrl: 'https://accounts.google.com/',
    pubkey: null,
    service: null,
    security: null,
    failure: null,
    tor: { onionAvailable: false, active: false },
    pendingHttp: null,
    programmatic: false,
    loading: false,
    favicon: null,
    audible: false,
    muted: false
  }
}

function fakeInternals(tabs: Tab[]): ShellInternals {
  return {
    deps: { httpPolicies: {} } as ShellInternals['deps'],
    syncState: vi.fn(),
    scheduleSessionSave: vi.fn(),
    activateTab: vi.fn(),
    showOnly: vi.fn(),
    applyUrlToTab: vi.fn(),
    openInNewTab: vi.fn(),
    handleInput: vi.fn(),
    hasTab: (tab) => tabs.includes(tab),
    showInsecurePrompt: vi.fn(),
    closeTab: vi.fn((id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id)
      if (index !== -1) tabs.splice(index, 1)
    })
  }
}

describe('wireTab', () => {
  it('closes the tab when its webContents self-destroys (e.g. an SSO popup closing itself)', () => {
    const contents = fakeContents()
    const tab = fakeTab(contents)
    const tabs = [tab]
    const internals = fakeInternals(tabs)

    wireTab(internals, tab)
    contents.emit('destroyed')

    expect(internals.closeTab).toHaveBeenCalledWith('t1')
    expect(tabs).toHaveLength(0)
  })

  it('does not try to close a tab that was already removed', () => {
    const contents = fakeContents()
    const tab = fakeTab(contents)
    const tabs: Tab[] = []
    const internals = fakeInternals(tabs)

    wireTab(internals, tab)
    contents.emit('destroyed')

    expect(internals.closeTab).not.toHaveBeenCalled()
  })
})
