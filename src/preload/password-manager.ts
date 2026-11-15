import { ipcRenderer } from 'electron'

/**
 * Isolated-world password bridge. It reads only the username and current password
 * of a visible login form, and only on a real submit; it never exposes an API to
 * page JavaScript.
 */

let scheduled: number | null = null
let lastState = ''
let lastCapture = { key: '', at: 0 }

export function installPasswordManager(): void {
  ipcRenderer.on('passwords:fill', (_event, payload) => {
    const value = payload as { requestId?: unknown; username?: unknown; password?: unknown }
    if (typeof value?.requestId !== 'string') return
    const result = fillForm(
      typeof value.username === 'string' ? value.username : '',
      typeof value.password === 'string' ? value.password : ''
    )
    ipcRenderer.send('passwords:fill-result', {
      requestId: value.requestId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {})
    })
  })

  document.addEventListener('submit', onSubmit, true)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
}

function start(): void {
  if (!document.documentElement) return
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'hidden', 'autocomplete']
  })
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
  schedule()
}

function schedule(): void {
  if (scheduled !== null) return
  scheduled = window.setTimeout(() => {
    scheduled = null
    reportState()
  }, 250)
}

function reportState(): void {
  const form = findLoginForm()
  const state = `${location.href}\u0000${form ? '1' : '0'}\u0000${document.title}`
  if (state === lastState) return
  lastState = state
  ipcRenderer.send('passwords:form-state', {
    hasLoginForm: Boolean(form),
    title: document.title.slice(0, 200)
  })
}

function onSubmit(event: Event): void {
  if (!event.isTrusted) return
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  const passwordFields = passwordInputs(form)
  const values = passwordFields.map((field) => field.value).filter((value) => value.length > 0)
  if (values.length === 0) return
  if (new Set(values).size > 1) return
  const password = values[0]
  const passwordField = passwordFields.find((field) => field.value === password)
  if (!passwordField) return
  const username = usernameFor(passwordField, form)?.value ?? ''
  const key = `${location.href}\u0000${username}\u0000${password}`
  if (lastCapture.key === key && Date.now() - lastCapture.at < 2_500) return
  lastCapture = { key, at: Date.now() }
  ipcRenderer.send('passwords:capture', {
    username: username.slice(0, 320),
    password: password.slice(0, 4096),
    title: document.title.slice(0, 200),
    formAction: form.action
  })
}

function fillForm(username: string, password: string): { ok: boolean; error?: string } {
  const form = findLoginForm()
  if (!form) return { ok: false, error: 'No login form was found on this page' }
  const passwordField = passwordInputs(form)[0]
  if (!passwordField) return { ok: false, error: 'No password field was found on this page' }
  const usernameField = usernameFor(passwordField, form)
  if (username && usernameField) setInputValue(usernameField, username)
  if (password) setInputValue(passwordField, password)
  passwordField.focus({ preventScroll: true })
  return { ok: true }
}

function findLoginForm(): HTMLElement | null {
  const active = document.activeElement
  if (active instanceof HTMLElement) {
    const form = active.closest('form')
    if (form && passwordInputs(form).length > 0) return form
  }
  for (const form of document.querySelectorAll('form')) {
    if (passwordInputs(form).length > 0) return form
  }
  const fields = passwordInputs(document)
  return fields.length > 0 ? (fields[0].form ?? document.body ?? null) : null
}

function passwordInputs(root: ParentNode): HTMLInputElement[] {
  return [...root.querySelectorAll('input')].filter(
    (input): input is HTMLInputElement =>
      input instanceof HTMLInputElement &&
      input.type === 'password' &&
      isVisible(input) &&
      !input.disabled &&
      !input.readOnly
  )
}

function usernameFor(
  password: HTMLInputElement,
  root: ParentNode
): HTMLInputElement | null {
  const candidates = [...root.querySelectorAll('input')].filter(
    (input): input is HTMLInputElement =>
      input instanceof HTMLInputElement &&
      input !== password &&
      isVisible(input) &&
      !input.disabled &&
      !input.readOnly &&
      (input.autocomplete === 'username' ||
        input.type === 'email' ||
        input.type === 'text' ||
        input.type === 'tel' ||
        !input.type)
  )
  const explicit = candidates.find((input) => input.autocomplete === 'username')
  if (explicit) return explicit
  const before = candidates.filter(
    (input) => password.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING
  )
  return before[before.length - 1] ?? candidates[0] ?? null
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  return element.getClientRects().length > 0
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
