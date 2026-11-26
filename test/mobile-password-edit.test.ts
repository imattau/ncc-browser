import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: the Android shell is plain JavaScript
import { createPasswords } from '../mobile/passwords.js'

/** Just enough of an element for the editor and the result banner. */
class FakeElement {
  children: FakeElement[] = []
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  className = ''
  value = ''
  hidden = false
  disabled = false
  readOnly = false
  private own = ''
  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.own = value
    this.children = []
  }
  append(...nodes: Array<FakeElement | string>) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = new FakeElement()
        text.textContent = node
        this.children.push(text)
      } else this.children.push(node)
    }
  }
  appendChild(node: FakeElement) {
    this.append(node)
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  scrollIntoView() {}
  querySelector() {
    return new FakeElement()
  }
  querySelectorAll() {
    return []
  }
}

function harness() {
  const elements = new Map<string, FakeElement>()
  const byId = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement())
    return elements.get(id)!
  }
  let finish: (outcome: unknown) => void = () => undefined
  const removed: string[] = []
  const saved: Array<{ id: string | null; title: string }> = []
  const shown: string[] = []
  const invoke = vi.fn(async (command: string, args?: { id: string; draft: { id: string | null; title: string } }) => {
    if (command === 'vault_save') {
      saved.push(args!.draft)
      return new Promise((resolve) => (finish = resolve))
    }
    if (command === 'vault_entry') {
      return { origin: 'https://example.com', title: `Login ${args!.id}`, username: 'alice', password: 'p', notes: '', totp: '' }
    }
    if (command === 'vault_remove') {
      removed.push(args!.id)
      return new Promise((resolve) => (finish = resolve))
    }
    if (command === 'vault_status') return { unlocked: false }
    return null
  })
  const show = (name: string) => {
    shown.push(name)
    byId('password-edit').hidden = name !== 'password-edit'
  }
  const passwords = createPasswords({ invoke, byId, set: () => undefined, showPanel: show })
  const open = async (id: string) => {
    await passwords.openPasswordEdit(id)
  }
  const toast = () => {
    const element = byId('vault-toast')
    return element.hidden ? null : { tone: element.children[0].dataset.tone, text: element.textContent }
  }
  return { passwords, byId, open, show, shown, removed, saved, toast, finish: (value: unknown) => finish(value) }
}

describe('saving and deleting a login on Android', () => {
  let answer = true
  const asked: string[] = []

  beforeEach(() => {
    answer = true
    asked.length = 0
    vi.useFakeTimers()
    const element = () => new FakeElement()
    vi.stubGlobal('document', { createElement: element, createElementNS: element })
    vi.stubGlobal('window', { confirm: (message: string) => (asked.push(message), answer) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function editing(id = 'a') {
    const h = harness()
    await h.open(id)
    return h
  }

  it('asks first, naming the login, and does nothing when cancelled', async () => {
    const h = await editing()
    answer = false
    await h.passwords.deleteEditing()
    expect(asked).toEqual(['Delete the login “Login a” for alice? This cannot be undone.'])
    expect(h.removed).toEqual([])
  })

  it('shows progress, ignores a second tap, then confirms success', async () => {
    const h = await editing()
    const running = h.passwords.deleteEditing()
    const button = h.byId('edit-delete')
    expect(button.textContent).toBe('Deleting…')
    expect(button.children[0].className).toBe('spinner')
    expect([button.disabled, h.byId('edit-save').disabled]).toEqual([true, true])
    await h.passwords.deleteEditing()
    expect(h.removed).toEqual(['a'])

    h.finish({ ok: true })
    await running

    expect(button.textContent).toBe('Delete login')
    expect([button.disabled, h.byId('edit-save').disabled]).toEqual([false, false])
    expect(h.shown.at(-1)).toBe('passwords')
    expect(h.toast()).toEqual({ tone: 'ok', text: 'Deleted “Login a”.' })
    vi.advanceTimersByTime(4000)
    expect(h.toast()).toBeNull()
  })

  it('warns when the delete has not reached the relays', async () => {
    const h = await editing()
    const running = h.passwords.deleteEditing()
    h.finish({ ok: true, pending: true })
    await running
    expect(h.toast()?.tone).toBe('warn')
  })

  it('stays on the login and shows why a delete failed', async () => {
    const h = await editing()
    const running = h.passwords.deleteEditing()
    h.finish({ ok: false, error: 'No vault relay is configured' })
    await running
    expect(h.shown.at(-1)).toBe('password-edit')
    const result = h.byId('edit-note').children[0]
    expect([result.dataset.tone, result.textContent]).toEqual(['error', 'No vault relay is configured'])
    expect(h.byId('edit-delete').disabled).toBe(false)
  })

  it('does not pull someone away from where they went while it ran', async () => {
    const h = await editing()
    const running = h.passwords.deleteEditing()
    await h.open('b')
    expect(h.byId('edit-delete').textContent).toBe('Delete login')
    expect(h.byId('edit-save').disabled).toBe(false)
    const panels = h.shown.length

    h.finish({ ok: false, error: 'offline' })
    await running

    expect(h.shown).toHaveLength(panels)
    expect(h.toast()).toEqual({ tone: 'error', text: '“Login a” was not deleted. offline' })
  })

  function adding(title = 'New') {
    const h = harness()
    h.passwords.openNewLogin('https://example.com')
    h.byId('edit-title').value = title
    return h
  }

  it('shows that a save is running and adds the login once however often it is tapped', async () => {
    const h = adding()
    const running = h.passwords.saveEdits()
    const button = h.byId('edit-save')
    expect(button.textContent).toBe('Saving…')
    expect(button.children[0].className).toBe('spinner')
    expect([button.disabled, h.byId('edit-generate').disabled, h.byId('edit-password').readOnly]).toEqual([true, true, true])
    await h.passwords.saveEdits()
    expect(h.saved).toHaveLength(1)

    h.finish({ ok: true })
    await running

    expect(button.textContent).toBe('Save login')
    expect([button.disabled, h.byId('edit-password').readOnly]).toEqual([false, false])
    expect(h.shown.at(-1)).toBe('passwords')
    expect(h.toast()).toEqual({ tone: 'ok', text: 'Saved “New”.' })
  })

  it('does not delete a login that is being saved', async () => {
    const h = await editing()
    const running = h.passwords.saveEdits()
    expect(h.byId('edit-delete').disabled).toBe(true)
    await h.passwords.deleteEditing()
    expect(asked).toEqual([])
    h.finish({ ok: true, pending: true })
    await running
    expect(h.toast()).toEqual({ tone: 'warn', text: 'Saved “Login a” on this device. Relay sync will retry.' })
  })

  it('keeps what was typed when a save fails, and allows another try', async () => {
    const h = adding()
    const running = h.passwords.saveEdits()
    h.finish({ ok: false, error: 'Enter an https:// or ncc:// address' })
    await running
    expect(h.shown.at(-1)).toBe('password-edit')
    expect(h.byId('edit-title').value).toBe('New')
    const result = h.byId('edit-note').children[0]
    expect([result.dataset.tone, result.textContent]).toEqual(['error', 'Enter an https:// or ncc:// address'])

    const again = h.passwords.saveEdits()
    expect(h.saved).toHaveLength(2)
    h.finish({ ok: true })
    await again
  })

  it('explains the wait on a second new login, and leaves it open when the first is saved', async () => {
    const h = adding('First')
    const running = h.passwords.saveEdits()
    h.passwords.openNewLogin('')
    expect(h.byId('edit-save').textContent).toBe('Save login')
    expect([h.byId('edit-save').disabled, h.byId('edit-title').readOnly]).toEqual([true, false])
    expect(h.byId('edit-note').textContent).toBe('Waiting for the last save to finish.')
    const panels = h.shown.length

    h.finish({ ok: false, error: 'offline' })
    await running

    expect(h.shown).toHaveLength(panels)
    expect(h.byId('edit-save').disabled).toBe(false)
    expect(h.byId('edit-note').textContent).toBe('')
    expect(h.toast()).toEqual({ tone: 'error', text: '“First” was not saved. offline' })
  })
})
