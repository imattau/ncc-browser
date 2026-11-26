/**
 * Finding, reading and filling login forms inside a web page. The desktop content
 * preload imports this file and `scripts/build-login-hook.mjs` compiles it into the
 * Android page script, so it must not import anything.
 *
 * Sites rarely sign in with a plain form submit, so a login is read when the person
 * submits, presses Enter, presses a button that looks like "sign in", or when the
 * password they typed leaves the page after they pressed something.
 */

export interface LoginCapture {
  username: string
  password: string
}

export type LoginFillResult = 'filled' | 'username' | 'none'

export interface LoginWatchHandlers {
  /** A login the person appears to have sent to the site. */
  capture(login: LoginCapture): void
  /** A username entered on a step that has no password field yet. */
  username(value: string): void
  /** The focused field entered or left a login form that could be filled. */
  focus(field: HTMLInputElement | null): void
}

const SUBMIT_LABEL =
  /\b(sign[\s-]?in|log[\s-]?in|logon|sign[\s-]?up|register|join|continue|next|submit|enter|unlock|authenticate|create|confirm|save|change|update|reset|set)\b/i
/** Controls that sit beside a password field but do not send it. */
const OTHER_LABEL =
  /\b(show|hide|reveal|view|toggle|forgot|forgotten|help|cancel|back|clear|close|generate|suggest|copy|qr|passkey|google|apple|facebook|github|microsoft)\b/i
const USERNAME_HINT = /(user|e-?mail|login|account|identifier|member|handle|phone|mobile|\buid\b)/i
const NOT_USERNAME =
  /(search|query|coupon|promo|captcha|\botp\b|one[\s-]?time|verification|2fa|mfa|totp|pin[\s-]?code|zip|postal|message|comment|subject|amount|quantity)/i

function tokens(input: HTMLInputElement): string[] {
  return (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

function describe(input: HTMLInputElement): string {
  return `${input.name} ${input.id} ${input.getAttribute('placeholder') ?? ''} ${input.getAttribute('aria-label') ?? ''}`
}

/** Every input under `root`, including those inside open shadow roots. */
function deepInputs(root: Document | ShadowRoot | Element): HTMLInputElement[] {
  const found: HTMLInputElement[] = []
  const visit = (node: Document | ShadowRoot | Element): void => {
    for (const element of node.querySelectorAll('*')) {
      if (element instanceof HTMLInputElement) found.push(element)
      if (element.shadowRoot) visit(element.shadowRoot)
    }
  }
  visit(root)
  return found
}

export function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden) return false
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  if (element.getClientRects().length === 0) return false
  const box = element.getBoundingClientRect()
  // Honeypots: too small to use, or parked off the top or left of the page.
  return box.width >= 4 && box.height >= 4 && box.right + scrollX > 0 && box.bottom + scrollY > 0
}

function usable(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly && isVisible(input)
}

/** A text field that could hold an account name. */
function couldBeUsername(input: HTMLInputElement): boolean {
  if (!['text', 'email', 'tel', ''].includes(input.getAttribute('type')?.toLowerCase() ?? '')) return false
  const auto = tokens(input)
  if (auto.includes('username')) return true
  if (auto.some((token) => token === 'one-time-code' || token.startsWith('cc-'))) return false
  return !NOT_USERNAME.test(describe(input))
}

function looksLikeUsername(input: HTMLInputElement): boolean {
  const auto = tokens(input)
  return auto.includes('username') || auto.includes('email') || input.type === 'email' || USERNAME_HINT.test(describe(input))
}

/** The part of the page that belongs to one password field. */
function scopeOf(field: HTMLInputElement): Element | ShadowRoot | Document {
  if (field.form) return field.form
  for (let node = field.parentElement; node && node !== document.body; node = node.parentElement) {
    if ([...node.querySelectorAll('input')].some((other) => other !== field && couldBeUsername(other))) return node
  }
  const root = field.getRootNode()
  return root instanceof ShadowRoot ? root : document
}

function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function pickUsername(candidates: HTMLInputElement[], password: HTMLInputElement): HTMLInputElement | null {
  const explicit = candidates.find((input) => tokens(input).includes('username'))
  if (explicit) return explicit
  const before = candidates.filter((input) => precedes(input, password)).reverse()
  return before.find(looksLikeUsername) ?? before[0] ?? candidates.find(looksLikeUsername) ?? null
}

/** The account name for a password field. `forFill` skips fields that cannot be typed in. */
function usernameFor(password: HTMLInputElement, forFill: boolean): HTMLInputElement | null {
  const inputs = deepInputs(scopeOf(password)).filter((input) => input !== password && couldBeUsername(input))
  const shown = pickUsername(inputs.filter((input) => (forFill ? usable(input) : isVisible(input))), password)
  if (shown || forFill) return shown
  // Two-step sign-ins keep the account in a hidden field for password managers.
  return inputs.find((input) => tokens(input).includes('username') && input.value !== '') ?? null
}

function passwordFields(root: Document | ShadowRoot | Element): HTMLInputElement[] {
  return deepInputs(root).filter((input) => input.type === 'password' && usable(input))
}

function isNewPassword(input: HTMLInputElement): boolean {
  return tokens(input).includes('new-password')
}

/**
 * The password the site will keep. A change or signup form repeats the new one, so
 * fields that disagree are only readable when it is clear which are the new password.
 */
export function chosenPassword(fields: HTMLInputElement[]): HTMLInputElement | null {
  const filled = fields.filter((field) => field.value !== '')
  if (filled.length === 0) return null
  const agree = (list: HTMLInputElement[]): boolean => list.every((field) => field.value === list[0].value)
  const fresh = filled.filter(isNewPassword)
  if (fresh.length > 0) return agree(fresh) ? fresh[0] : null
  if (agree(filled)) return filled[0]
  if (filled.length === 3 && filled[1].value === filled[2].value) return filled[1]
  if (filled.length === 2 && tokens(filled[0]).includes('current-password')) return filled[1]
  return null
}

function readLogin(field: HTMLInputElement): LoginCapture | null {
  const scope = scopeOf(field)
  const password = chosenPassword(passwordFields(scope))
  if (!password) return null
  const username = usernameFor(password, false)?.value ?? ''
  return { username: username.slice(0, 320), password: password.value.slice(0, 4096) }
}

/** The element that has focus, looking inside open shadow roots. */
function deepActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

/** The password field a saved login belongs in, preferring where the person is. */
function loginPasswordField(): HTMLInputElement | null {
  const fields = passwordFields(document).filter((field) => !isNewPassword(field))
  if (fields.length === 0) return null
  const active = deepActiveElement()
  if (active instanceof HTMLInputElement) {
    const near = fields.find((field) => field === active) ?? fields.find((field) => scopeOf(field).contains(active))
    if (near) return near
  }
  return (
    fields.find((field) => tokens(field).includes('current-password')) ??
    // A form with one password field is a sign-in; two or more is usually signup.
    fields.find((field) => passwordFields(scopeOf(field)).length === 1) ??
    fields[0]
  )
}

/** The username box of a sign-in that asks for the password on a later step. */
function usernameStepField(): HTMLInputElement | null {
  if (passwordFields(document).length > 0) return null
  const fields = deepInputs(document).filter((input) => usable(input) && couldBeUsername(input))
  const active = deepActiveElement()
  return (
    fields.find((input) => input === active && looksLikeUsername(input)) ??
    fields.find((input) => tokens(input).includes('username')) ??
    fields.find((input) => input.form !== null && looksLikeUsername(input) && SUBMIT_LABEL.test(formButtonText(input.form))) ??
    null
  )
}

function formButtonText(form: HTMLFormElement): string {
  return [...form.querySelectorAll('button, input[type=submit]')].map(labelOf).join(' ')
}

/** True when the page has somewhere a saved login could go. */
export function hasLoginForm(): boolean {
  return loginPasswordField() !== null || usernameStepField() !== null
}

/** True when filling `field`, or the login it belongs to, makes sense. */
export function isLoginField(field: HTMLInputElement): boolean {
  if (!usable(field)) return false
  if (field.type === 'password') return !isNewPassword(field) && passwordFields(scopeOf(field)).length === 1
  if (!couldBeUsername(field)) return false
  const password = loginPasswordField()
  if (password) return passwordFields(scopeOf(password)).length === 1 && usernameFor(password, true) === field
  return usernameStepField() === field
}

export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export function fillLogin(username: string, password: string): LoginFillResult {
  const passwordField = password ? loginPasswordField() : null
  if (passwordField) {
    const usernameField = username ? usernameFor(passwordField, true) : null
    if (usernameField) {
      usernameField.focus({ preventScroll: true })
      setInputValue(usernameField, username)
    }
    passwordField.focus({ preventScroll: true })
    setInputValue(passwordField, password)
    return 'filled'
  }
  const step = username ? usernameStepField() : null
  if (!step) return 'none'
  step.focus({ preventScroll: true })
  setInputValue(step, username)
  return 'username'
}

function labelOf(element: Element): string {
  const value = element instanceof HTMLInputElement ? element.value : ''
  return `${element.textContent?.slice(0, 80) ?? ''} ${value} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`.trim()
}

const CONTROL = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a'

/** Whether a pressed control sends the form, does something else, or is unclear. */
function controlKind(control: Element): 'send' | 'other' | 'unknown' {
  const label = `${labelOf(control)} ${control.id} ${control.getAttribute('name') ?? ''}`
  if (OTHER_LABEL.test(label)) return 'other'
  if (SUBMIT_LABEL.test(label)) return 'send'
  const type = control.getAttribute('type')?.toLowerCase()
  if (type === 'submit' || type === 'image') return 'send'
  if (control instanceof HTMLButtonElement && control.form && !type) return 'send'
  return 'unknown'
}

/** Report logins, username steps and login-field focus. Returns a function that stops. */
export function watchLogins(handlers: LoginWatchHandlers): () => void {
  /** The password field the person typed in, and what the form held at that moment. */
  let typed: { field: HTMLInputElement; login: LoginCapture } | null = null
  /** They pressed something after typing, so a vanishing form means it was sent. */
  let acted = false
  let reported = ''
  let lastUsername = ''
  let focused: HTMLInputElement | null = null
  let timer: number | null = null

  const report = (login: LoginCapture): void => {
    const key = `${login.username}\u0000${login.password}`
    if (key === reported) return
    reported = key
    handlers.capture(login)
  }

  const reportUsernameStep = (): void => {
    if (passwordFields(document).length > 0) return
    const field = usernameStepField()
    const value = field?.value.trim() ?? ''
    if (!value || value === lastUsername) return
    lastUsername = value
    handlers.username(value.slice(0, 320))
  }

  const target = (event: Event): Element | null => {
    const first = event.composedPath()[0]
    return first instanceof Element ? first : null
  }

  const onInput = (event: Event): void => {
    const field = target(event)
    if (!event.isTrusted || !(field instanceof HTMLInputElement) || field.type !== 'password') return
    const login = readLogin(field)
    typed = login ? { field, login } : null
    acted = false
    reported = ''
  }

  /** The person pressed Enter or a button that sends what they typed. */
  const sent = (): void => {
    if (!typed) {
      reportUsernameStep()
      return
    }
    // Read again so a username entered after the password is included.
    const login = (typed.field.isConnected ? readLogin(typed.field) : null) ?? typed.login
    report(login)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const field = target(event)
    if (!event.isTrusted || event.key !== 'Enter' || event.isComposing || !(field instanceof HTMLInputElement)) return
    acted = true
    sent()
  }

  const onClick = (event: MouseEvent): void => {
    if (!event.isTrusted) return
    const path = event.composedPath().filter((node): node is Element => node instanceof Element)
    if (path[0] instanceof HTMLInputElement && !path[0].matches(CONTROL)) return
    const control = path.find((node) => node.matches(CONTROL))
    const kind = control ? controlKind(control) : 'unknown'
    // "Show password" or "Forgot password?" must not turn a half-typed one into an offer.
    acted = kind !== 'other'
    if (!control || kind !== 'send') return
    if (typed?.field.form && control.closest('form') && control.closest('form') !== typed.field.form) return
    sent()
  }

  const onSubmit = (event: Event): void => {
    const form = target(event)
    if (!event.isTrusted || !(form instanceof HTMLFormElement)) return
    const field = passwordFields(form).find((candidate) => candidate.value !== '')
    if (!field) {
      reportUsernameStep()
      return
    }
    const login = readLogin(field)
    if (!login) return
    typed = { field, login }
    report(login)
  }

  const checkGone = (): void => {
    if (!typed || !acted || isVisible(typed.field)) return
    // A re-rendered form still has a password box; only a form that left counts.
    if (passwordFields(document).length === 0) report(typed.login)
    typed = null
  }

  const updateFocus = (): void => {
    const active = deepActiveElement()
    // Focus on nothing keeps the last offer: tapping the browser's own bar does this.
    if (!active || active === document.body) return
    const next = active instanceof HTMLInputElement && isLoginField(active) ? active : null
    if (next === focused) return
    focused = next
    handlers.focus(next)
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      checkGone()
      updateFocus()
    }, 250)
  }

  const onFocusIn = (): void => updateFocus()
  const onClickFocus = (): void => {
    if (focused && deepActiveElement() === focused) handlers.focus(focused)
  }
  const onChange = (event: Event): void => {
    if (event.isTrusted && target(event) instanceof HTMLInputElement) reportUsernameStep()
  }
  // A script calling form.submit() fires nothing but this. `pagehide` alone can come
  // too late to get a message out.
  const onLeave = (): void => {
    if (typed && acted) report(typed.login)
  }

  const listeners: [EventTarget, string, EventListener][] = [
    [document, 'input', onInput],
    [document, 'keydown', onKeyDown as EventListener],
    [document, 'click', onClick as EventListener],
    // Tapping an already focused field asks for the offer again.
    [document, 'click', onClickFocus],
    [document, 'submit', onSubmit],
    [document, 'change', onChange],
    [document, 'focusin', onFocusIn],
    [window, 'beforeunload', onLeave],
    [window, 'pagehide', onLeave]
  ]
  for (const [on, name, listener] of listeners) on.addEventListener(name, listener, true)

  const observer = new MutationObserver(schedule)
  const start = (): void => {
    if (!document.documentElement) return
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'style', 'class', 'hidden', 'autocomplete', 'disabled']
    })
    // An autofocused field never fires focusin where we can hear it.
    schedule()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  return () => {
    observer.disconnect()
    if (timer !== null) clearTimeout(timer)
    for (const [on, name, listener] of listeners) on.removeEventListener(name, listener, true)
  }
}
