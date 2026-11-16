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
let panel = 'home'
let proxyPort = null
let activeUrl = ''
let activeTitle = ''
let browserSettings = null
let signerTimer = null
let signerDeadline = 0

const PANELS = [
  'home',
  'switcher',
  'info',
  'menu',
  'appearance',
  'relays',
  'search',
  'security',
  'storage',
  'identity',
  'signer-settings',
  'history',
  'bookmarks',
  'about'
]

const HISTORY_KEY = 'ncc.history'
const BOOKMARKS_KEY = 'ncc.bookmarks'

function readList(key) {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writeList(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable; history just does not persist.
  }
}

function recordVisit(url, title) {
  if (!url) return
  const address = displayAddress(url)
  const entries = readList(HISTORY_KEY).filter((entry) => entry.address !== address)
  entries.unshift({ address, title: title || '', at: Date.now() })
  writeList(HISTORY_KEY, entries.slice(0, 200))
}

function toggleBookmark(address, title) {
  const entries = readList(BOOKMARKS_KEY)
  const index = entries.findIndex((entry) => entry.address === address)
  if (index >= 0) entries.splice(index, 1)
  else entries.unshift({ address, title: title || '', at: Date.now() })
  writeList(BOOKMARKS_KEY, entries)
  renderBookmarks()
}

function listRow(label, detail, onClick, action) {
  const row = document.createElement('button')
  row.type = 'button'
  row.style.textAlign = 'left'

  const strong = document.createElement('strong')
  strong.textContent = label
  const small = document.createElement('small')
  small.style.display = 'block'
  small.style.color = 'var(--muted)'
  small.textContent = detail

  row.append(strong, small)
  row.addEventListener('click', onClick)

  if (action) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'secondary'
    remove.textContent = action.label
    remove.style.marginTop = '8px'
    remove.addEventListener('click', action.onClick)

    const wrapper = document.createElement('div')
    wrapper.append(row, remove)
    return wrapper
  }

  return row
}

function renderHistory() {
  const container = byId('history-list')
  container.textContent = ''

  const entries = readList(HISTORY_KEY)
  if (entries.length === 0) {
    container.textContent = 'No history yet.'
    return
  }

  for (const entry of entries) {
    container.appendChild(
      listRow(
        entry.title || entry.address,
        `${entry.address} · ${new Date(entry.at).toLocaleString()}`,
        () => openAddress(entry.address)
      )
    )
  }
}

function renderBookmarks() {
  const container = byId('bookmarks-list')
  container.textContent = ''

  const entries = readList(BOOKMARKS_KEY)
  if (entries.length === 0) {
    container.textContent = 'No bookmarks yet.'
    return
  }

  for (const entry of entries) {
    container.appendChild(
      listRow(entry.title || entry.address, entry.address, () => openAddress(entry.address), {
        label: 'Remove',
        onClick: () => toggleBookmark(entry.address, entry.title)
      })
    )
  }
}

function openAddress(address) {
  byId('address').value = address
  closePanel()
  void open(proxyPort)
}

async function loadRelays() {
  const input = byId('relays-input')
  byId('relays-error').textContent = ''
  try {
    browserSettings = await globalThis.__TAURI__.core.invoke('browser_settings')
    input.value = browserSettings.relays.join('\n')
    byId('gossip').checked = browserSettings.gossip
  } catch (error) {
    byId('relays-error').textContent = String(error)
  }
}

async function saveRelays() {
  const relays = byId('relays-input')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  try {
    browserSettings = await globalThis.__TAURI__.core.invoke('settings_set_relays', { relays })
    browserSettings = await globalThis.__TAURI__.core.invoke('settings_set_gossip', {
      value: byId('gossip').checked
    })
    byId('relays-input').value = browserSettings.relays.join('\n')
    byId('relays-error').textContent = 'Saved. The next lookup uses these.'
  } catch (error) {
    byId('relays-error').textContent = String(error)
  }
}

async function loadSearch() {
  try {
    browserSettings = await globalThis.__TAURI__.core.invoke('browser_settings')
    byId('search-engine').value = browserSettings.searchEngine
    byId('search-custom').value = browserSettings.searchEngineCustom
    byId('search-custom-label').textContent =
      browserSettings.searchEngine === 'custom' ? 'Template with %s' : 'SearXNG instance'
  } catch (error) {
    byId('search-error').textContent = String(error)
  }
}

async function saveSearch() {
  try {
    browserSettings = await globalThis.__TAURI__.core.invoke('settings_set_search', {
      engine: byId('search-engine').value,
      custom: byId('search-custom').value.trim()
    })
    byId('search-error').textContent = 'Saved.'
  } catch (error) {
    byId('search-error').textContent = String(error)
  }
}

async function loadSecurity() {
  try {
    browserSettings = await globalThis.__TAURI__.core.invoke('browser_settings')
    byId('https-mode').value = browserSettings.httpsMode
    byId('warn-insecure').checked = browserSettings.warnInsecure
  } catch (error) {
    byId('security-error').textContent = String(error)
  }
}

async function saveSecurity() {
  try {
    browserSettings = await globalThis.__TAURI__.core.invoke('settings_set_https', {
      mode: byId('https-mode').value,
      warn: byId('warn-insecure').checked
    })
    byId('security-error').textContent = 'Saved.'
  } catch (error) {
    byId('security-error').textContent = String(error)
  }
}

const SEARCH_TEMPLATES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  startpage: 'https://www.startpage.com/sp/search?query=%s',
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s'
}

function searchUrl(text) {
  const engine = browserSettings?.searchEngine || 'duckduckgo'
  const custom = browserSettings?.searchEngineCustom || ''

  const template =
    engine === 'custom' && custom
      ? custom
      : engine === 'searx'
        ? `${(custom || 'https://searx.be').replace(/\/+$/, '')}/search?q=%s`
        : SEARCH_TEMPLATES[engine] || SEARCH_TEMPLATES.duckduckgo

  return template.replace('%s', encodeURIComponent(text))
}

/** Address, URL or search — the same three-way split the desktop omnibox makes. */
function classifyInput(value) {
  if (/^(ncc|nsite):/i.test(value)) return 'address'
  if (/^npub1[0-9a-z]{20,}(\/|$)/i.test(value)) return 'address'
  if (/^[0-9a-f]{64}(\/|$)/i.test(value)) return 'address'
  if (/^https?:\/\//i.test(value)) return 'external'
  if (!value.includes(' ') && /^[^\s.]+(\.[^\s.]+)+/.test(value)) return 'external'
  return 'search'
}

async function loadPermissions() {
  const container = byId('permissions')
  container.textContent = ''

  try {
    const services = await globalThis.__TAURI__.core.invoke('signer_permissions')
    if (services.length === 0) {
      container.textContent = 'No service is trusted yet.'
      return
    }

    for (const service of services) {
      container.appendChild(
        listRow(service, 'Does not ask again this session', () => {}, {
          label: 'Revoke',
          onClick: async () => {
            await globalThis.__TAURI__.core.invoke('signer_revoke', { service })
            await loadPermissions()
          }
        })
      )
    }
  } catch (error) {
    container.textContent = String(error)
  }
}
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

  if (panel === 'switcher') renderTabGrid()
  if (tabs.length === 0 && panel === 'switcher') {
    panel = 'home'
    applyLayout()
  }

  const active = tabs.find((tab) => tab.id === activeTabId)
  if (active && active.url) {
    activeUrl = active.url
    activeTitle = active.title || ''
    byId('bar-address').textContent = displayAddress(active.url)
  }
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
      panel = 'home'
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

/** Every full-window surface is the shell expanded over the page. */
function showPanel(name) {
  if (!content) return
  panel = name
  content?.expand(true)
  if (name === 'switcher') {
    content.capture()
    renderTabGrid()
  }
  if (name === 'info') void loadInfo()
  if (name === 'signer-settings') void loadPermissions()
  if (name === 'relays') void loadRelays()
  if (name === 'search') void loadSearch()
  if (name === 'security') void loadSecurity()
  if (name === 'history') renderHistory()
  if (name === 'bookmarks') renderBookmarks()
  applyLayout()
}

function closePanel() {
  panel = 'home'
  if (tabs.length > 0) content?.expand(false)
  applyLayout()
}

/** What the proxy knows about the page in front of you. */
async function loadInfo() {
  const body = byId('info-body')
  body.textContent = 'Loading…'

  if (!activeUrl) {
    body.textContent = 'No page is open.'
    return
  }

  let host = ''
  try {
    host = new URL(activeUrl).host
  } catch {
    body.textContent = 'The current address is not a page.'
    return
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/__ncc/info?u=${encodeURIComponent(host)}`
    )
    renderInfo(await response.json())
  } catch (error) {
    body.textContent = String(error)
  }
}

function renderInfo(data) {
  const body = byId('info-body')
  body.textContent = ''

  const section = (title) => {
    const heading = document.createElement('p')
    heading.className = 'info-section'
    heading.textContent = title
    body.appendChild(heading)
  }

  const row = (label, value) => {
    if (value === undefined || value === null || value === '') return
    const line = document.createElement('div')
    line.className = 'info-row'
    const term = document.createElement('dt')
    term.textContent = label
    const detail = document.createElement('dd')
    detail.textContent = String(value)
    line.append(term, detail)
    body.appendChild(line)
  }

  const when = (seconds) =>
    seconds ? new Date(seconds * 1000).toLocaleString() : null

  if (data.error) {
    section('Problem')
    row('error', data.error)
    return
  }

  section(data.kind === 'nsite' ? 'Site' : 'Service')
  row('kind', data.kind)
  row('identity', data.pubkey)
  if (data.service) row('service', data.service)
  if (data.site) row('site', data.site)
  if (data.title) row('title', data.title)

  section('Record')
  if (data.dTag) row('d tag', data.dTag)
  row('event', data.event)
  row('updated', when(data.updated))
  row('expires', when(data.expires))
  if (data.paths) row('files', data.paths)

  if (data.endpoints && data.endpoints.length > 0) {
    section('Endpoints')
    for (const endpoint of data.endpoints) {
      row(
        endpoint.family,
        `${endpoint.host} · ${endpoint.protocol}${endpoint.pinned ? ' · pinned' : ''}`
      )
    }
  }

  if (data.servers && data.servers.length > 0) {
    section('Blossom')
    for (const server of data.servers) row('server', server)
  }
}

/** Events from the native content surface. */
globalThis.__nccContent = (state) => {
  const lines = [
    `${state.type}${state.title ? ` · ${state.title}` : ''}`,
    state.url ? `url: ${state.url}` : null,
    state.reason ? `reason: ${state.reason}` : null
  ].filter(Boolean)

  byId('result').textContent = lines.join('\n')

  if (state.type === 'loaded') {
    recordVisit(state.url, state.title)
    if (tabs.find((tab) => tab.id === state.tab)?.active) {
      activeUrl = state.url
      activeTitle = state.title || ''
    }
  }

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

  try {
    const version = await tauri.app.getVersion()
    set('version', version)
    set('about-version', version)
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

  proxyPort = port
  set('proxy', `127.0.0.1:${port}`)
  set('about-proxy', `127.0.0.1:${port}`)
  byId('go').textContent = content
    ? 'Open in the content view'
    : 'Fetch through the proxy'
  byId('go').addEventListener('click', () => open(port))
  byId('close').addEventListener('click', () => content?.close())

  byId('signer-allow').addEventListener('click', () => answerSigner(true))
  byId('signer-deny').addEventListener('click', () => answerSigner(false))
  await setupIdentity(tauri)
  try {
    browserSettings = await tauri.core.invoke('browser_settings')
  } catch {
    // Fall back to the defaults above.
  }

  if (content) {
    byId('collapse').addEventListener('click', () => content.expand(false))
    byId('bar-back').addEventListener('click', () => content.back())
    byId('bar-reload').addEventListener('click', () => content.reload())
    byId('bar-address').addEventListener('click', () => {
      panel = 'home'
      content.expand(true)
      applyLayout()
      byId('address').focus()
    })
    for (const button of document.querySelectorAll('[data-panel]')) {
      button.addEventListener('click', () => showPanel(button.dataset.panel))
    }

    byId('bar-tabs').addEventListener('click', () => showPanel('switcher'))
    byId('switcher-done').addEventListener('click', () => closePanel())
    byId('switcher-new').addEventListener('click', () => startNewTab())

    byId('bar-info').addEventListener('click', () => showPanel('info'))
    byId('info-done').addEventListener('click', () => closePanel())
    byId('bar-menu').addEventListener('click', () => showPanel('menu'))
    byId('menu-done').addEventListener('click', () => closePanel())
    byId('menu-reload').addEventListener('click', () => {
      content.reload()
      closePanel()
    })
    byId('menu-new').addEventListener('click', () => startNewTab())
    byId('menu-close').addEventListener('click', () => {
      content.closeTab(activeTabId)
      closePanel()
    })
    byId('menu-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(displayAddress(activeUrl))
      } catch {
        // Clipboard access can be refused; the address is on screen anyway.
      }
      closePanel()
    })
    byId('menu-settings').addEventListener('click', () => {
      panel = 'home'
      applyLayout()
    })
    byId('menu-history').addEventListener('click', () => showPanel('history'))
    byId('menu-bookmark').addEventListener('click', () => {
      if (activeUrl) toggleBookmark(displayAddress(activeUrl), activeTitle)
      closePanel()
    })
    byId('relays-save').addEventListener('click', () => void saveRelays())
    byId('search-save').addEventListener('click', () => void saveSearch())
    byId('search-engine').addEventListener('change', () => {
      byId('search-custom-label').textContent =
        byId('search-engine').value === 'custom' ? 'Template with %s' : 'SearXNG instance'
    })
    byId('security-save').addEventListener('click', () => void saveSecurity())
    byId('clear-cache').addEventListener('click', async () => {
      byId('storage-note').textContent = 'Clearing…'
      try {
        await globalThis.__TAURI__.core.invoke('clear_cache')
        content?.clearWebCache()
        byId('storage-note').textContent = 'Cache cleared.'
      } catch (error) {
        byId('storage-note').textContent = String(error)
      }
    })
    byId('history-clear').addEventListener('click', () => {
      writeList(HISTORY_KEY, [])
      renderHistory()
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
  signerDeadline = Date.now() + 120_000
  byId('signer-countdown').textContent = 'Expires in 120s'
  if (signerTimer) clearInterval(signerTimer)
  signerTimer = setInterval(tickSigner, 1000)
  byId('signer-service').textContent = request.service
  byId('signer-method').textContent =
    request.method + (request.kind ? ` · kind ${request.kind}` : '')
  byId('signer-preview').textContent = request.preview || '(nothing to show)'
  byId('signer').hidden = false
  byId('signer-remember').checked = false
  content?.expand(true)
}

function tickSigner() {
  const left = Math.max(0, Math.round((signerDeadline - Date.now()) / 1000))
  byId('signer-countdown').textContent =
    left > 0 ? `Expires in ${left}s` : 'Expired — the request was denied.'

  if (left === 0) {
    if (signerTimer) clearInterval(signerTimer)
    signerTimer = null
    signerRequest = null
    byId('signer').hidden = true
  }
}

async function answerSigner(allow) {
  if (!signerRequest) return

  if (signerTimer) clearInterval(signerTimer)
  signerTimer = null
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

function startNewTab() {
  newTabMode = true
  panel = 'home'
  content?.expand(true)
  applyLayout()
  byId('go').textContent = 'Open in a new tab'
  byId('address').focus()
}

function applyLayout() {
  const compact = window.innerHeight < 200
  document.body.classList.toggle('compact', compact)
  byId('bar').hidden = !compact

  for (const name of PANELS) {
    const element = byId(name)
    if (element) element.hidden = compact || panel !== name
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
  const input = byId('address').value.trim()
  if (!input) return

  const kind = classifyInput(input)
  if (kind !== 'address') {
    const url = kind === 'search' ? searchUrl(input) : (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
    byId('result').textContent = `opening ${url} externally`
    if (content) content.openExternal(url)
    else globalThis.open?.(url, '_blank', 'noopener')
    return
  }

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
