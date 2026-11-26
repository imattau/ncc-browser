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
  const shown: string[] = []
  const invoke = vi.fn(async (command: string, args?: { id: string }) => {
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
  return { passwords, byId, open, show, shown, removed, toast, finish: (value: unknown) => finish(value) }
}

describe('deleting a login on Android', () => {
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
})
