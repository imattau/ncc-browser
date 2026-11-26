import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: the Android shell is plain JavaScript
import { createLoginDock } from '../mobile/login-dock.js'

/** Just enough of an element for the sheet. */
class FakeElement {
  children: FakeElement[] = []
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  listeners: Record<string, () => void> = {}
  className = ''
  type = ''
  hidden = false
  disabled = false
  offsetHeight = 150
  private own = ''
  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join('|')
  }
  set textContent(value: string) {
    this.own = value
    this.children = []
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes)
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners[name] = listener
  }
}

const PAGE = 'https://example.com'
const LOGIN = { id: 'a', title: 'Example', username: 'alice', isPasskey: false }
const OFFER = { id: 'r1', origin: PAGE, username: 'alice', mode: 'create', locked: false }

function harness() {
  const elements = new Map<string, FakeElement>()
  const byId = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement())
    return elements.get(id)!
  }
  const state = {
    unlocked: true,
    matches: [LOGIN],
    activeTab: 't1',
    unlock: { ok: true } as { ok: boolean; error?: string },
    capture: OFFER as unknown
  }
  const responses: Array<(value: unknown) => void> = []
  const calls: Array<[string, unknown]> = []
  const invoke = vi.fn(async (command: string, args: unknown) => {
    calls.push([command, args])
    if (command === 'vault_matches') return state.matches
    if (command === 'vault_capture') return state.capture
    if (command === 'vault_fill') return { username: 'alice', password: 's3cret' }
    if (command === 'vault_respond') return new Promise((resolve) => responses.push(resolve))
    return null
  })
  const content = { dock: vi.fn(), fillLogin: vi.fn() }
  let allowed = true
  const dock = createLoginDock({
    content,
    invoke,
    byId,
    displayAddress: (url: string) => url.replace('https://', ''),
    showPanel: vi.fn(),
    relayout: () => dock.sync(allowed),
    activeKind: () => 'normal',
    vault: {
      status: async () => ({ configured: true, unlocked: state.unlocked }),
      ensureUnlocked: async () => {
        if (state.unlock.ok) state.unlocked = true
        return state.unlock
      },
      changed: async () => undefined
    },
    getTabs: () => [{ id: 't1', kind: 'normal' }],
    getActiveTabId: () => state.activeTab
  })
  const up = () => !byId('login-dock').hidden && dock.height() > 0
  const calledWith = (name: string) => calls.filter(([command]) => command === name).map(([, args]) => args)
  const tick = () => vi.advanceTimersByTimeAsync(0)
  return {
    dock, content, byId, state, up, calledWith, tick,
    focus: (login = true) => dock.handleFocus({ tab: 't1', url: PAGE, login }),
    capture: () => dock.handleCapture({ tab: 't1', url: PAGE, username: 'alice', password: 's3cret', title: '' }),
    rows: () => byId('dock-list').children,
    note: () => byId('dock-note').textContent,
    reply: async (value: unknown) => { responses.shift()!(value); await tick() },
    cover: (covered: boolean) => { allowed = !covered; dock.sync(allowed) }
  }
}

describe('the Android login sheet', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { createElement: () => new FakeElement() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('offers saved logins for a focused field and fills the tapped one on that page only', async () => {
    const h = harness()
    await h.focus()
    expect(h.up()).toBe(true)
    expect(h.content.dock).toHaveBeenLastCalledWith(151)
    expect(h.rows().map((row) => row.textContent)).toEqual(['alice|Example'])

    h.rows()[0].listeners.click()
    await h.tick()
    expect(h.content.fillLogin).toHaveBeenCalledWith('t1', 'alice', 's3cret', PAGE)
    expect(h.up()).toBe(false)
    expect(h.content.dock).toHaveBeenLastCalledWith(0)
  })

  it('stays away when nothing is saved, and leaves when focus moves on', async () => {
    const h = harness()
    h.state.matches = []
    await h.focus()
    expect(h.up()).toBe(false)

    h.state.matches = [LOGIN]
    await h.focus()
    await h.focus(false)
    expect(h.up()).toBe(false)
  })

  it('unlocks from the sheet, then lists the logins', async () => {
    const h = harness()
    h.state.unlocked = false
    await h.focus()
    expect(h.rows()[0].textContent).toContain('Unlock passwords')

    h.rows()[0].listeners.click()
    await h.tick()
    expect(h.rows()[0].textContent).toContain('alice')
  })

  it('stays closed after Close until the page loads again', async () => {
    const h = harness()
    await h.focus()
    h.dock.close()
    await h.focus()
    expect(h.up()).toBe(false)

    h.dock.pageLoading('t1')
    await h.focus()
    expect(h.up()).toBe(true)
  })

  it('does not fill after a switch to another tab', async () => {
    const h = harness()
    await h.focus()
    const row = h.rows()[0]
    h.state.activeTab = 't2'
    row.listeners.click()
    await h.tick()
    expect(h.content.fillLogin).not.toHaveBeenCalled()
  })

  it('keeps a save offer while the next page loads and comes back after a panel', async () => {
    const h = harness()
    await h.capture()
    h.dock.pageLoading('t1')
    expect(h.byId('dock-title').textContent).toBe('Save this login?')

    h.cover(true)
    expect(h.up()).toBe(false)
    h.cover(false)
    expect(h.up()).toBe(true)
  })

  it.each(['dismiss', 'never'])('leaves at once on %s, without showing a save', async (action) => {
    const h = harness()
    await h.capture()
    void h.dock.respond(action)
    expect(h.up()).toBe(false)
    expect(h.byId('save-accept').textContent).not.toBe('Saving…')
    await h.tick()
    expect(h.calledWith('vault_respond')).toEqual([{ id: 'r1', action }])
    await h.reply({ ok: true })
    expect(h.up()).toBe(false)
  })

  it('shows progress, saves once despite a double tap, then confirms and leaves', async () => {
    const h = harness()
    await h.capture()
    void h.dock.respond('save')
    void h.dock.respond('save')
    await h.tick()
    expect(h.byId('save-accept').textContent).toBe('Saving…')
    expect(h.byId('save-accept').disabled).toBe(true)
    expect(h.byId('save-dismiss').disabled).toBe(true)
    expect(h.calledWith('vault_respond')).toHaveLength(1)

    await h.reply({ ok: true, pending: false })
    expect(h.note()).toContain('Login saved.')
    expect(h.byId('dock-actions').hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.up()).toBe(false)
  })

  it('says why a save failed and lets the same offer be tried again', async () => {
    const h = harness()
    await h.capture()
    void h.dock.respond('save')
    await h.tick()
    await h.reply({ ok: false, error: 'No relay accepted it' })
    expect(h.note()).toContain('No relay accepted it')
    expect(h.byId('save-accept').textContent).toBe('Try again')
    expect(h.byId('save-accept').disabled).toBe(false)

    void h.dock.respond('save')
    await h.tick()
    await h.reply({ ok: true, pending: true })
    expect(h.calledWith('vault_respond')).toEqual([{ id: 'r1', action: 'save' }, { id: 'r1', action: 'save' }])
    expect(h.note()).toContain('Relay sync will retry')
  })

  it('keeps the offer when unlocking is cancelled', async () => {
    const h = harness()
    h.state.unlock = { ok: false, error: 'Unlock was cancelled.' }
    await h.capture()
    await h.dock.respond('save')
    expect(h.note()).toContain('Unlock was cancelled.')
    expect(h.calledWith('vault_respond')).toEqual([])
    expect(h.up()).toBe(true)
  })

  it('shows a newer sign-in after the save already running', async () => {
    const h = harness()
    await h.capture()
    void h.dock.respond('save')
    await h.tick()
    h.state.capture = { ...OFFER, id: 'r2', username: 'bob' }
    await h.capture()
    expect(h.byId('dock-detail').textContent).toContain('alice')

    await h.reply({ ok: true, pending: false })
    expect(h.byId('dock-detail').textContent).toContain('bob')
    expect(h.byId('save-accept').textContent).toBe('Save login')
  })

  it('reports a fill that did not finish', async () => {
    const h = harness()
    h.dock.filled('username')
    expect(h.note()).toContain('Username filled')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.up()).toBe(false)
    h.dock.filled('moved')
    expect(h.note()).toContain('nothing was filled')
  })
})
