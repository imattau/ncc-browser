/**
 * M0 shell.
 *
 * The address field asks the platform to open a virtual host. On Android that goes
 * through `window.NccContent` — a `@JavascriptInterface` on the shell's WebView — and
 * the page appears in a real content WebView on top of the shell. In a browser or on
 * desktop, where that bridge does not exist, the same button falls back to a fetch,
 * which still proves the proxy and the `*.localhost` mapping.
 */

const byId = (id) => document.getElementById(id)

function set(id, value) {
  byId(id).textContent = value
}

function summarise(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

const content = globalThis.NccContent

let contentOpen = false
let tabs = []
let activeTabId = ''
let switcherOpen = false
let newTabMode = false

/**
 * `http://<npub>.<service>.localhost:<port>/x` is what the content view loads; what
 * belongs in a 56 dp strip is the address the user typed.
 */
function displayAddress(url) {
  try {
    const parsed = new URL(url)

    if (parsed.hostname.endsWith('.nsite.localhost')) {
      // pubkey.site.nsite.localhost, or pubkey.nsite.localhost for the root site.
      const labels = parsed.hostname.split('.')
      const pubkey = labels[0]
      const site = labels.length === 4 ? labels[1] : null
      return `nsite://${pubkey}${site ? `/${site}` : ''}${parsed.pathname}`
    }

    if (!parsed.hostname.endsWith('.localhost')) return url
    const labels = parsed.hostname.split('.')
    const pubkey = labels[0]
    const service = labels.length > 2 ? labels[1] : null
    return `ncc://${pubkey}${service ? `/${service}` : ''}${parsed.pathname}`
  } catch {
    return url
  }
}

/** Tab list from the native tab manager. */
globalThis.__nccTabs = (payload) => {
  tabs = payload.tabs || []
  activeTabId = payload.active || ''

  byId('bar-tabs').textContent = String(Math.max(tabs.length, 1))

  if (switcherOpen) renderTabGrid()
  if (tabs.length === 0 && switcherOpen) {
    switcherOpen = false
    applyLayout()
  }

  const active = tabs.find((tab) => tab.id === activeTabId)
  if (active && active.url) byId('bar-address').textContent = displayAddress(active.url)
}

function renderTabGrid() {
  const grid = byId('tab-grid')
  grid.textContent = ''

  for (const tab of tabs) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = tab.active ? 'tab-card active' : 'tab-card'

    if (tab.thumbnail) {
      const image = document.createElement('img')
      image.src = tab.thumbnail
      image.alt = ''
      card.appendChild(image)
    } else {
      const blank = document.createElement('div')
      blank.className = 'tab-blank'
      card.appendChild(blank)
    }

    const label = document.createElement('span')
    label.textContent = tab.title || displayAddress(tab.url || '') || 'New tab'
    card.appendChild(label)

    const close = document.createElement('span')
    close.className = 'tab-close'
    close.textContent = '×'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      content?.closeTab(tab.id)
    })
    card.appendChild(close)

    card.addEventListener('click', () => {
      switcherOpen = false
      applyLayout()
      content?.select(tab.id)
    })

    grid.appendChild(card)
  }

  if (tabs.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'note'
    empty.textContent = 'No tabs yet.'
    grid.appendChild(empty)
  }
}

function showSwitcher() {
  if (!content) return
  switcherOpen = true
  content.capture()
  content.expand(true)
  renderTabGrid()
  applyLayout()
}

function closeSwitcher() {
  switcherOpen = false
  if (tabs.length > 0) content?.expand(false)
  applyLayout()
}

/** Events from the native content surface. */
globalThis.__nccContent = (state) => {
  const lines = [
    `${state.type}${state.title ? ` · ${state.title}` : ''}`,
    state.url ? `url: ${state.url}` : null,
    state.reason ? `reason: ${state.reason}` : null
  ].filter(Boolean)

  byId('result').textContent = lines.join('\n')

  if (state.type === 'loaded' || state.type === 'blocked' || state.type === 'failed') {
    contentOpen = true
    byId('close').hidden = false
    byId('collapse').hidden = !content ? true : false
    byId('bar-address').textContent = displayAddress(state.url || '')
  }
  if (state.type === 'closed') {
    contentOpen = false
    byId('close').hidden = true
    byId('collapse').hidden = true
    byId('bar-address').textContent = 'no page'
  }
}

globalThis.__nccContentReady = () => {
  set('bridge', 'ok (content bridge)')
}

async function main() {
  const tauri = globalThis.__TAURI__

  if (!tauri) {
    set('bridge', 'missing')
    set('proxy', 'unavailable')
    byId('result').textContent =
      'window.__TAURI__ is absent: this is a plain WebView, not the shell.'
    return
  }

  set('bridge', 'ok')
  set('secure', globalThis.isSecureContext ? 'yes' : 'no')
  set('sw', 'serviceWorker' in navigator ? 'available' : 'absent')

  try {
    set('version', await tauri.app.getVersion())
  } catch {
    // Informational only.
  }

  let port = null
  try {
    port = await tauri.core.invoke('proxy_port')
  } catch (error) {
    set('proxy', `invoke failed: ${error?.message ?? error}`)
    return
  }

  if (!port) {
    set('proxy', 'not started')
    byId('go').disabled = true
    return
  }

  set('proxy', `127.0.0.1:${port}`)
  byId('go').textContent = content
    ? 'Open in the content view'
    : 'Fetch through the proxy'
  byId('go').addEventListener('click', () => open(port))
  byId('close').addEventListener('click', () => content?.close())

  byId('signer-allow').addEventListener('click', () => answerSigner(true))
  byId('signer-deny').addEventListener('click', () => answerSigner(false))
  await setupIdentity(tauri)

  if (content) {
    byId('collapse').addEventListener('click', () => content.expand(false))
    byId('bar-back').addEventListener('click', () => content.back())
    byId('bar-reload').addEventListener('click', () => content.reload())
    byId('bar-address').addEventListener('click', () => {
      switcherOpen = false
      content.expand(true)
      applyLayout()
      byId('address').focus()
    })
    byId('bar-tabs').addEventListener('click', () => showSwitcher())
    byId('switcher-done').addEventListener('click', () => closeSwitcher())
    byId('switcher-new').addEventListener('click', () => {
      newTabMode = true
      switcherOpen = false
      content.expand(true)
      applyLayout()
      byId('go').textContent = 'Open in a new tab'
      byId('address').focus()
    })
    byId('bar-position').addEventListener('change', (event) => applyBarPosition(event.target.value))
    applyBarPosition(globalThis.localStorage?.getItem('ncc.bar') || 'bottom')
    window.addEventListener('resize', applyLayout)
    applyLayout()
  }
}

/**
 * Accept what a person actually pastes: `ncc://npub…/service`, `npub…/service`,
 * a hex key, or a bare key for the default service.
 */
/**
 * The strip is the same page at 56 dp. Which half renders is decided by the viewport
 * the shell hands us, so no extra bridge call is needed to know the mode.
 */
/** Identity status drives which of the three panels is visible. */
let identity = null
let signerRequest = null

function renderIdentity(status) {
  identity = status
  const state = byId('identity-state')

  if (!status.initialised) {
    state.textContent = 'No identity on this device yet.'
  } else if (status.unlocked) {
    state.textContent = `Unlocked: ${status.npub}`
  } else {
    state.textContent = `Locked: ${status.npub}`
  }

  byId('identity-setup').hidden = status.initialised
  byId('identity-locked').hidden = !status.initialised || status.unlocked
  byId('identity-lock').hidden = !status.unlocked
}

async function refreshIdentity() {
  try {
    renderIdentity(await globalThis.__TAURI__.core.invoke('identity_status'))
  } catch (error) {
    byId('identity-state').textContent = `Identity unavailable: ${error}`
  }
}

function identityFailure(error) {
  byId('identity-error').textContent = String(error)
}

async function setupIdentity(tauri) {
  const invoke = tauri.core.invoke

  byId('identity-create').addEventListener('click', async () => {
    const passphrase = byId('passphrase').value
    if (passphrase.length < 8) {
      identityFailure('Use at least 8 characters.')
      return
    }
    try {
      renderIdentity(await invoke('identity_create', { passphrase }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-import').addEventListener('click', async () => {
    const passphrase = byId('passphrase').value
    const secret = byId('nsec').value.trim()
    if (passphrase.length < 8 || !secret) {
      identityFailure('A passphrase of at least 8 characters and an nsec are required.')
      return
    }
    try {
      renderIdentity(await invoke('identity_import', { passphrase, secret }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-unlock').addEventListener('click', async () => {
    try {
      renderIdentity(await invoke('identity_unlock', { passphrase: byId('unlock-passphrase').value }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-lock').addEventListener('click', async () => {
    renderIdentity(await invoke('identity_lock'))
  })

  await tauri.event.listen('ncc:signer', (event) => showSigner(event.payload))
  await refreshIdentity()
}

/** A page is waiting on an answer, so take the window until it has one. */
function showSigner(request) {
  signerRequest = request
  byId('signer-service').textContent = request.service
  byId('signer-method').textContent =
    request.method + (request.kind ? ` · kind ${request.kind}` : '')
  byId('signer-preview').textContent = request.preview || '(nothing to show)'
  byId('signer').hidden = false
  byId('signer-remember').checked = false
  content?.expand(true)
}

async function answerSigner(allow) {
  if (!signerRequest) return
  const request = signerRequest
  signerRequest = null

  try {
    await globalThis.__TAURI__.core.invoke('signer_respond', {
      id: request.id,
      allow,
      remember: byId('signer-remember').checked,
      service: request.service
    })
  } catch {
    // The request is gone either way; the page sees its own error.
  }

  byId('signer').hidden = true
  if (contentOpen) content?.expand(false)
}

function applyLayout() {
  const compact = window.innerHeight < 200
  document.body.classList.toggle('compact', compact)
  byId('bar').hidden = !compact

  if (compact) {
    byId('stage').hidden = true
    byId('switcher').hidden = true
  } else {
    byId('stage').hidden = switcherOpen
    byId('switcher').hidden = !switcherOpen
  }

  if (!compact && contentOpen) byId('collapse').hidden = false
}

/** Toolbar position is a user setting; the default matches Firefox and Brave. */
function applyBarPosition(position) {
  const value = position === 'top' ? 'top' : 'bottom'
  byId('bar-position').value = value
  globalThis.localStorage?.setItem('ncc.bar', value)
  content?.setBarPosition(value)
}

function parseAddress(input) {
  const text = input
    .trim()
    .replace(/^ncc:\/\//i, '')
    .replace(/^\/+/, '')

  if (!text) return { error: 'Enter an npub and, optionally, a service.' }

  const [pubkey, rawService = ''] = text.split('/')
  const service = rawService.trim() || 'addr'

  if (!/^(npub1[0-9a-z]{20,}|[0-9a-f]{64})$/i.test(pubkey)) {
    return {
      error: 'Expected an npub (npub1…) or a 64-character hex pubkey, then an optional /service.'
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(service)) {
    return { error: `"${service}" is not a valid service name.` }
  }

  return { pubkey: pubkey.toLowerCase(), service }
}

/**
 * `nsite://npub/d/path` addresses a named site, `nsite://npub/path` the root one.
 *
 * The first segment is only a site id when it could be one: `index.html` cannot, so it
 * is a root-site path. The ambiguous middle ground — a bare word that is also a
 * directory — resolves as a site, which is the common case and what the desktop does
 * when such a site is published.
 */
function nsiteTarget(input, port) {
  const rest = input.replace(/^nsite:\/\//i, '').replace(/^\/+/, '')
  const [pubkey, ...segments] = rest.split('/')

  if (!/^(npub1[0-9a-z]{20,}|[0-9a-f]{64})$/i.test(pubkey || '')) {
    return { error: 'An nsite address starts with an npub.' }
  }

  let site = null
  if (segments.length > 0 && /^[a-z0-9-]{1,13}$/i.test(segments[0]) && !segments[0].endsWith('-')) {
    site = segments.shift().toLowerCase()
  }

  const path = segments.length > 0 ? `/${segments.join('/')}` : '/'
  return {
    url: `http://${pubkey.toLowerCase()}${site ? `.${site}` : ''}.nsite.localhost:${port}${path}`
  }
}

function targetUrl(port) {
  const value = byId('address').value.trim()
  if (/^nsite:/i.test(value)) return nsiteTarget(value, port)

  const parsed = parseAddress(value)
  if (parsed.error) return { error: parsed.error }
  return { url: `http://${parsed.pubkey}.${parsed.service}.localhost:${port}/` }
}

async function open(port) {
  let target = targetUrl(port)

  // For a site, whether a `d`-like segment is a name or a path depends on what is
  // published, so ask the proxy instead of guessing here.
  if (/^nsite:/i.test(byId('address').value.trim())) {
    try {
      const query = encodeURIComponent(byId('address').value.trim())
      const response = await fetch(`http://127.0.0.1:${port}/__ncc/route?u=${query}`)
      if (response.ok) target = await response.json()
    } catch {
      // Fall back to the local guess; the proxy will answer 404 if it is wrong.
    }
  }

  if (target.error) {
    byId('result').textContent = target.error
    return
  }

  byId('close').hidden = true
  byId('result').textContent = `opening ${target.url}`

  if (content) {
    content.open(target.url)
    return
  }
  void probe(target.url)
}

async function probe(url) {
  byId('result').textContent = `GET ${url}\n…`
  const started = performance.now()

  try {
    const response = await fetch(url, { cache: 'no-store' })
    const body = await response.text()
    const elapsed = Math.round(performance.now() - started)

    byId('result').textContent = [
      `${response.status} ${response.statusText} · ${elapsed} ms`,
      `content-type: ${response.headers.get('content-type') ?? 'none'}`,
      `url: ${url}`,
      '',
      summarise(body) || '(empty body)'
    ].join('\n')
  } catch (error) {
    byId('result').textContent = [
      'fetch failed',
      `url: ${url}`,
      '',
      String(error?.message ?? error)
    ].join('\n')
  }
}

void main()
