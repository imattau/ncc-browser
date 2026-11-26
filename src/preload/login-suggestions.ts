import type { PasswordSuggestions } from '../shared/passwords'

/**
 * Saved logins listed under the focused field. Drawn in a closed shadow root so page
 * script cannot read the account names or press the buttons. It only ever holds
 * names; choosing one asks the main process to fill.
 */

interface Actions {
  select(id: string): void
  unlock(): void
}

let host: HTMLElement | null = null
let dispose: (() => void) | null = null

const STYLE = `:host{all:initial}section{font:13px system-ui,sans-serif;color:#f5f6f7;background:#20242c;border:1px solid #596273;border-radius:10px;box-shadow:0 8px 28px #0008;padding:5px;max-height:240px;overflow-y:auto}h1{font:600 11px system-ui,sans-serif;color:#b6bfcc;margin:0;padding:5px 9px 4px}button{display:block;width:100%;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;padding:8px 9px;cursor:pointer}button:hover,button:focus{background:#35415a;outline:none}span,small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{color:#b6bfcc;margin-top:2px}`

export function hideLoginSuggestions(): void {
  dispose?.()
  dispose = null
  host?.remove()
  host = null
}

export function showLoginSuggestions(field: HTMLInputElement, suggestions: PasswordSuggestions, actions: Actions): void {
  hideLoginSuggestions()
  if (!field.isConnected) return
  const element = document.createElement('div')
  const root = element.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  const list = document.createElement('section')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Saved logins')
  const heading = document.createElement('h1')
  heading.textContent = 'Passwords'
  list.append(heading)

  const add = (title: string, detail: string, choose: () => void): void => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'option')
    const name = document.createElement('span')
    name.textContent = title
    const small = document.createElement('small')
    small.textContent = detail
    button.append(name, small)
    // Keeps focus in the page's field, which is what gets filled.
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      hideLoginSuggestions()
      choose()
    })
    list.append(button)
  }
  if (suggestions.locked) add('Unlock passwords', 'See logins saved for this site', actions.unlock)
  for (const item of suggestions.items) add(item.label, item.detail, () => actions.select(item.id))

  const place = (): void => {
    const box = field.getBoundingClientRect()
    const width = Math.min(340, Math.max(240, box.width))
    // Below the field, or above it when there is no room or the passkey list is there.
    const passkeys = document.getElementById('ncc-passkey-suggestions')
    const above = (passkeys !== null && !passkeys.hidden) || (box.bottom + 250 > innerHeight && box.top > 250)
    element.style.cssText =
      `position:fixed;z-index:2147483647;width:${width}px;left:${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px;` +
      (above ? `bottom:${innerHeight - box.top + 4}px;` : `top:${box.bottom + 4}px;`)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hideLoginSuggestions()
  }
  // Typing means the person is not choosing from the list.
  const onInput = (): void => hideLoginSuggestions()
  const onBlur = (): void => {
    window.setTimeout(() => {
      if (host === element) hideLoginSuggestions()
    }, 180)
  }
  field.addEventListener('input', onInput)
  field.addEventListener('blur', onBlur)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
  dispose = () => {
    field.removeEventListener('input', onInput)
    field.removeEventListener('blur', onBlur)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', place, true)
    window.removeEventListener('resize', place)
  }

  root.append(style, list)
  place()
  document.documentElement.append(element)
  host = element
}
