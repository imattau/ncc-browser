import { ipcRenderer } from 'electron'
import { fillLogin, hasLoginForm, setInputValue, watchLogins } from '../shared/login-forms'
import type { PasswordSuggestions } from '../shared/passwords'
import { hideLoginSuggestions, showLoginSuggestions } from './login-suggestions'

/**
 * Isolated-world password bridge. It reads a username and password only when the
 * person sends them to the site (see `login-forms.ts`), and it never exposes an API
 * to page JavaScript.
 */

let scheduled: number | null = null
let lastState = ''
/** The login field the person is in, which suggestions are drawn against. */
let loginField: HTMLInputElement | null = null
let cardSuggestionRoot: HTMLElement | null = null
let capturePaymentSecurityCode = false

export function installPasswordManager(): void {
  ipcRenderer.on('passwords:fill', (_event, payload) => {
    const value = payload as { requestId?: unknown; username?: unknown; password?: unknown; pageUrl?: unknown }
    if (typeof value?.requestId !== 'string') return
    hideLoginSuggestions()
    const answer = (result: { ok: boolean; error?: string; usernameOnly?: boolean }): void =>
      ipcRenderer.send('passwords:fill-result', { requestId: value.requestId, ...result })
    if (typeof value.pageUrl !== 'string' || !isThisPage(value.pageUrl)) {
      answer({ ok: false, error: 'The page changed, so nothing was filled' })
      return
    }
    const filled = fillLogin(
      typeof value.username === 'string' ? value.username : '',
      typeof value.password === 'string' ? value.password : ''
    )
    if (filled === 'none') answer({ ok: false, error: 'No login form was found on this page' })
    else answer({ ok: true, ...(filled === 'username' ? { usernameOnly: true } : {}) })
  })

  ipcRenderer.on('passwords:suggestions', (_event, payload) => {
    if (!loginField) return
    showLoginSuggestions(loginField, payload as PasswordSuggestions, {
      select: (id) => ipcRenderer.send('passwords:suggestion-selected', id),
      unlock: () => ipcRenderer.send('passwords:suggestion-unlock')
    })
  })
  watchLogins({
    capture: (login) => ipcRenderer.send('passwords:capture', { ...login, title: document.title.slice(0, 200) }),
    username: (username) => ipcRenderer.send('passwords:username', { username }),
    focus: (field) => {
      loginField = field
      hideLoginSuggestions()
      if (field) ipcRenderer.send('passwords:field-focused')
    }
  })

  ipcRenderer.on('payments:suggestions', (_event, payload) => {
    const cards = Array.isArray(payload) ? payload as Array<{ id: string; name: string; last4: string; network: string; nickname: string }> : []
    showCardSuggestions(cards)
  })
  ipcRenderer.on('payments:security-code-setting', (_event, enabled) => {
    capturePaymentSecurityCode = enabled === true
  })
  ipcRenderer.on('payments:fill', (_event, payload) => {
    const card = payload as { name?: unknown; number?: unknown; expMonth?: unknown; expYear?: unknown; cvc?: unknown }
    const result = fillCard(card)
    hideCardSuggestions()
    if (!result) ipcRenderer.send('payments:fill-result', { ok: false })
  })
  ipcRenderer.on('payments:fill-error', (_event, error) => showCardError(String(error ?? 'Could not fill card')))
  document.addEventListener('focusin', onPaymentFocus, true)
  document.addEventListener('focusout', () => window.setTimeout(hideCardSuggestions, 180), true)

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
  const found = hasLoginForm()
  const state = `${location.href}\u0000${found ? '1' : '0'}\u0000${document.title}`
  if (state === lastState) return
  lastState = state
  ipcRenderer.send('passwords:form-state', {
    hasLoginForm: found,
    title: document.title.slice(0, 200)
  })
}

function onSubmit(event: Event): void {
  if (!event.isTrusted) return
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  const card = readCardFromForm(form)
  if (card) ipcRenderer.send('payments:capture', card)
}

/** Compares scheme and host only: sites rewrite the path while a fill is in flight. */
function isThisPage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl)
    return url.protocol === location.protocol && url.host === location.host
  } catch {
    return false
  }
}

function onPaymentFocus(event: FocusEvent): void {
  if (!event.isTrusted) return
  const input = event.target
  if (!(input instanceof HTMLInputElement) || !cardFieldType(input)) return
  ipcRenderer.send('payments:field-focused')
}

function readCardFromForm(form: HTMLFormElement): { name: string; number: string; expMonth: string; expYear: string; cvc?: string } | null {
  const fields = visibleInputs(form)
  const pick = (kind: string): HTMLInputElement | undefined => fields.find((field) => cardFieldType(field) === kind)
  const number = (pick('number')?.value ?? '').replace(/\D/g, '').slice(0, 19)
  if (number.length < 12) return null
  const name = pick('name')?.value ?? ''
  const monthField = pick('month')?.value ?? ''
  const yearField = pick('year')?.value ?? ''
  const expiration = pick('expiry')?.value ?? ''
  const match = expiration.match(/(\d{1,2})\D+(\d{2,4})/)
  const expMonth = (monthField || match?.[1] || '').replace(/\D/g, '').slice(0, 2)
  const expYear = (yearField || match?.[2] || '').replace(/\D/g, '').slice(-4)
  if (!expMonth || !expYear) return null
  const cvc = capturePaymentSecurityCode ? fields.find((field) => cardFieldType(field) === 'cvc')?.value.replace(/\D/g, '').slice(0, 4) : undefined
  return { name: name.slice(0, 100), number, expMonth, expYear, ...(cvc && /^\d{3,4}$/.test(cvc) ? { cvc } : {}) }
}

type CardFieldKind = 'number' | 'name' | 'month' | 'year' | 'expiry' | 'type' | 'cvc' | null
function cardFieldType(input: HTMLInputElement): CardFieldKind {
  const autocomplete = input.autocomplete.toLowerCase().split(/\s+/).find((token) => token.startsWith('cc-')) ?? ''
  if (autocomplete === 'cc-number') return 'number'
  if (autocomplete === 'cc-name') return 'name'
  if (autocomplete === 'cc-exp-month') return 'month'
  if (autocomplete === 'cc-exp-year') return 'year'
  if (autocomplete === 'cc-exp') return 'expiry'
  if (autocomplete === 'cc-type') return 'type'
  if (autocomplete === 'cc-csc') return 'cvc'
  const label = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`.toLowerCase()
  if (/cvc|cvv|security.?code|card.?code/.test(label)) return 'cvc'
  if (/(card.?number|cc.?number|credit.?card.?number)/.test(label)) return 'number'
  if (/(card.?holder|name.?on.?card|cc.?name)/.test(label)) return 'name'
  if (/(expir|cc.?exp)/.test(label) && /month|mm/.test(label)) return 'month'
  if (/(expir|cc.?exp)/.test(label) && /year|yy/.test(label)) return 'year'
  if (/(expir|cc.?exp)/.test(label)) return 'expiry'
  return null
}

function visibleInputs(root: ParentNode): HTMLInputElement[] {
  return [...root.querySelectorAll('input')].filter((input): input is HTMLInputElement =>
    input instanceof HTMLInputElement && isVisible(input) && !input.disabled && !input.readOnly)
}

function fillCard(card: { name?: unknown; number?: unknown; expMonth?: unknown; expYear?: unknown; cvc?: unknown }): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLInputElement) || !cardFieldType(active)) return false
  const form = active.form ?? document
  const fields = visibleInputs(form)
  const values: Record<string, string> = {
    number: typeof card.number === 'string' ? card.number : '',
    name: typeof card.name === 'string' ? card.name : '',
    month: typeof card.expMonth === 'string' ? card.expMonth : '',
    year: typeof card.expYear === 'string' ? card.expYear : '',
    expiry: typeof card.expMonth === 'string' && typeof card.expYear === 'string' ? `${card.expMonth}/${card.expYear}` : '',
    cvc: typeof card.cvc === 'string' ? card.cvc : ''
  }
  let filled = false
  for (const field of fields) {
    const kind = cardFieldType(field)
    if (!kind || kind === 'type') continue
    const value = values[kind]
    if (value) { setInputValue(field, value); filled = true }
  }
  return filled
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  return element.getClientRects().length > 0
}

function showCardSuggestions(cards: Array<{ id: string; name: string; last4: string; network: string; nickname: string }>): void {
  hideCardSuggestions()
  const active = document.activeElement
  if (!(active instanceof HTMLInputElement) || !cardFieldType(active)) return
  if (!cards.length) return
  const rect = active.getBoundingClientRect()
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;z-index:2147483647;left:${Math.max(8, rect.left)}px;top:${Math.min(innerHeight - 8, rect.bottom + 4)}px;`
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `:host{all:initial}section{font:13px system-ui,sans-serif;color:#f5f6f7;background:#20242c;border:1px solid #596273;border-radius:10px;box-shadow:0 8px 28px #0008;padding:5px;min-width:240px;max-width:340px}button{display:block;width:100%;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;padding:9px;cursor:pointer}button:hover,button:focus{background:#35415a;outline:none}small{display:block;color:#b6bfcc;margin-top:3px}`
  const section = document.createElement('section')
  section.setAttribute('role', 'listbox')
  for (const card of cards.slice(0, 8)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.innerHTML = ''
    const title = document.createElement('span')
    title.textContent = `${card.nickname || card.network} •••• ${card.last4}`
    const detail = document.createElement('small')
    detail.textContent = card.name || 'Saved payment card'
    button.append(title, detail)
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', () => { ipcRenderer.send('payments:fill-selected', card.id); hideCardSuggestions() })
    section.append(button)
  }
  root.append(style, section)
  document.documentElement.append(host)
  cardSuggestionRoot = host
}

function hideCardSuggestions(): void { cardSuggestionRoot?.remove(); cardSuggestionRoot = null }
function showCardError(message: string): void {
  hideCardSuggestions()
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;'
  const root = host.attachShadow({ mode: 'closed' })
  const box = document.createElement('div')
  box.textContent = message
  box.style.cssText = 'font:13px system-ui,sans-serif;color:#fff;background:#7c2d2d;border-radius:8px;padding:10px 14px;box-shadow:0 4px 18px #0008;'
  root.append(box)
  document.documentElement.append(host)
  window.setTimeout(() => host.remove(), 3500)
}
