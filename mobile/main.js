/**
 * Mobile chrome.
 *
 * The shell's WebView is both the toolbar and every full-screen surface: Kotlin resizes
 * it between one row (`compact`) and the whole window. Which half renders is decided by
 * the viewport it is handed, so no bridge call is needed to know the mode.
 *
 * On Android `window.NccContent` is a `@JavascriptInterface` that owns the tab
 * WebViews. In a plain browser, where it does not exist, the address field falls back
 * to a fetch, which still proves the proxy and the `*.localhost` mapping.
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
const SVG_NS = 'http://www.w3.org/2000/svg'

/** An icon from the sprite in index.html. */
function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', `i ${className}`.trim())
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.appendChild(use)
  return svg
}

function setIcon(svg, name) {
  svg.querySelector('use')?.setAttribute('href', `#i-${name}`)
}

let tabs = []
let activeTabId = ''
let panel = 'home'
let proxyPort = null
let activeUrl = ''
let activeTitle = ''
let browserSettings = null
let signerTimer = null
let signerDeadline = 0
let signerRequest = null
let newTabMode = false
let pendingFocus = null
let findOpen = false
let findTimer = null
let identity = null

/** Loading progress per tab id, 0–100. Absent means idle. */
const progressByTab = {}
let progressTimer = null

const PANELS = [
  'home',
  'omnibox',
  'switcher',
  'menu',
  'info',
  'settings',
  'appearance',
  'relays',
  'search',
  'security',
  'storage',
  'identity',
  'signer-settings',
  'history',
  'bookmarks',
  'downloads',
  'about'
]

/** Where "back" goes from a panel. Anything not listed closes the panel. */
const PANEL_PARENT = {
  appearance: 'settings',
  relays: 'settings',
  search: 'settings',
  security: 'settings',
  storage: 'settings',
  identity: 'settings',
  'signer-settings': 'settings',
  about: 'settings'
}

const OVERLAYS = new Set(['menu', 'info'])

const DEFAULT_ADDRESS = 'ncc://npub1zapstdvcqpkwqh0sq3685kw87mqlruv9zuck5kxk0m9eazlsd5xq2juxuw'

const ICONS_KEY = 'ncc.icons'
const HISTORY_KEY = 'ncc.history'
const BOOKMARKS_KEY = 'ncc.bookmarks'

/* ───────────────────────────── Storage ───────────────────────────── */

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

function isBookmarked(address) {
  return readList(BOOKMARKS_KEY).some((entry) => entry.address === address)
}

function toggleBookmark(address, title) {
  const entries = readList(BOOKMARKS_KEY)
  const index = entries.findIndex((entry) => entry.address === address)
  if (index >= 0) entries.splice(index, 1)
  else entries.unshift({ address, title: title || '', at: Date.now() })
  writeList(BOOKMARKS_KEY, entries)
  renderBookmarks()
  return index < 0
}

/* ───────────────────────────── Addresses ───────────────────────────── */

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

function shortId(id) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

/** Split an address into the identity (kept) and the rest (what the pill truncates). */
function addressParts(url) {
  const address = displayAddress(url)
  const match = address.match(/^(ncc|nsite):\/\/([^/]+)(\/.*)?$/i)
  if (match) {
    return { scheme: match[1].toLowerCase(), id: shortId(match[2]), rest: (match[3] || '').replace(/\/$/, '') }
  }
  try {
    const parsed = new URL(address)
    return { scheme: parsed.protocol.replace(':', ''), id: parsed.host, rest: parsed.pathname.replace(/\/$/, '') }
  } catch {
    return { scheme: '', id: address, rest: '' }
  }
}

/** A short human label for an entry: its title, else the service, else the identity. */
function labelFor(entry) {
  if (entry.title) return entry.title
  const parts = addressParts(entry.address)
  const service = parts.rest.split('/')[1]
  return service || parts.id
}

/** Favicons are kept per service (`ncc://<id>/<service>`), not per page. */
function iconKey(address) {
  const match = String(address).match(/^((?:ncc|nsite):\/\/[^/]+(?:\/[^/]+)?)/i)
  return match ? match[1] : String(address)
}

function readIcons() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(ICONS_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function saveIcon(address, dataUrl) {
  const icons = readIcons()
  const key = iconKey(address)
  delete icons[key] // re-insert so the most recent sit last
  icons[key] = dataUrl
  const keys = Object.keys(icons)
  for (const stale of keys.slice(0, Math.max(0, keys.length - 60))) delete icons[stale]
  try {
    globalThis.localStorage?.setItem(ICONS_KEY, JSON.stringify(icons))
  } catch {
    // Quota or unavailable: the letter avatar is the fallback.
  }
}

/**
 * The service's own icon when the page has supplied one, otherwise a gradient tile
 * with its initial. Both are the same box, so a late icon swaps in without reflow.
 */
function avatar(text, className = '', address = '') {
  const element = document.createElement('span')
  element.className = `avatar ${className}`.trim()

  const stored = address ? readIcons()[iconKey(address)] : null
  if (stored) {
    const image = document.createElement('img')
    image.src = stored
    image.alt = ''
    image.draggable = false
    element.classList.add('has-icon')
    element.appendChild(image)
    return element
  }

  const letter = (text.match(/[a-z0-9]/i)?.[0] || 'N').toUpperCase()
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  element.style.background = `linear-gradient(135deg, hsl(${hue} 68% 52%), hsl(${(hue + 42) % 360} 72% 40%))`
  element.textContent = letter
  return element
}

/* ───────────────────────────── Security state ───────────────────────────── */

const SECURITY = {
  pinned: { label: 'Secure', detail: 'Pinned certificate matches the locator', lock: 'shield-check' },
  tls: { label: 'Secure', detail: 'HTTPS endpoint', lock: 'shield-check' },
  verified: { label: 'Verified', detail: 'Site files are checked against their hashes', lock: 'shield-check' },
  onion: { label: 'Onion service', detail: 'Reached through a Tor onion endpoint', lock: 'shield-check' },
  plain: { label: 'Not secure', detail: 'This service is only offered over cleartext HTTP', lock: 'shield-alert' },
  unknown: { label: 'Unverified', detail: 'No endpoint information yet', lock: 'shield' }
}

const securityCache = new Map()

function classifySecurity(data) {
  if (!data || data.error) return 'unknown'
  if (data.kind === 'nsite') return 'verified'
  const endpoints = data.endpoints || []
  if (endpoints.some((endpoint) => endpoint.pinned)) return 'pinned'
  if (endpoints.some((endpoint) => /https/i.test(endpoint.protocol || ''))) return 'tls'
  if (endpoints.some((endpoint) => endpoint.family === 'onion')) return 'onion'
  if (endpoints.length > 0) return 'plain'
  return 'unknown'
}

async function fetchInfo(url) {
  const host = new URL(url).host
  const response = await fetch(`http://127.0.0.1:${proxyPort}/__ncc/info?u=${encodeURIComponent(host)}`)
  return response.json()
}

async function securityFor(url) {
  if (!url) return 'unknown'

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'unknown'
  }

  // Nothing to resolve for a clearnet page, so nothing can be pinned or verified:
  // whether it is TLS is answered by the URL itself.
  if (!parsed.hostname.endsWith('.localhost')) {
    return parsed.protocol === 'https:' ? 'tls' : 'plain'
  }

  if (!proxyPort) return 'unknown'
  const key = parsed.host
  if (securityCache.has(key)) return securityCache.get(key)
  try {
    const state = classifySecurity(await fetchInfo(url))
    securityCache.set(key, state)
    return state
  } catch {
    return 'unknown'
  }
}

let securityState = 'unknown'

async function refreshSecurity() {
  const url = activeUrl
  const state = url ? await securityFor(url) : 'unknown'
  if (url !== activeUrl) return
  securityState = state
  renderPill()
}

/* ───────────────────────────── The strip ───────────────────────────── */

function renderPill() {
  const address = byId('bar-address')
  address.textContent = ''

  if (activeUrl) {
    const parts = addressParts(activeUrl)
    const id = document.createElement('span')
    id.className = 'pill-id'
    id.textContent = parts.id
    const rest = document.createElement('span')
    rest.className = 'pill-rest'
    rest.textContent = parts.rest
    address.append(id, rest)
  } else {
    const placeholder = document.createElement('span')
    placeholder.className = 'pill-placeholder'
    placeholder.textContent = 'Search or enter address'
    address.appendChild(placeholder)
  }

  const lock = byId('bar-info')
  const state = activeUrl ? securityState : 'unknown'
  lock.dataset.state = state
  setIcon(lock.querySelector('svg'), SECURITY[state].lock)

  const loading = progressByTab[activeTabId] !== undefined
  const reload = byId('bar-reload')
  setIcon(reload.querySelector('svg'), loading ? 'close' : 'reload')
  reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload')

  renderProgress()
}

function renderProgress() {
  const bar = byId('progress')
  const value = progressByTab[activeTabId]
  if (progressTimer) clearTimeout(progressTimer)
  progressTimer = null

  if (value !== undefined) {
    bar.classList.add('on')
    bar.style.width = `${Math.max(value, 8)}%`
  } else if (bar.classList.contains('on')) {
    bar.style.width = '100%'
    progressTimer = setTimeout(() => {
      bar.classList.remove('on')
      bar.style.width = '0'
    }, 220)
  }
}

let lastTabCount = null

function renderCounts() {
  const count = tabs.length > 99 ? '99+' : String(tabs.length)
  set('bar-tabs-n', count)
  set('home-tabs-n', count)
  for (const id of ['bar-tabs-n', 'home-tabs-n']) {
    const badge = byId(id)
    badge.dataset.multi = tabs.length > 1 ? '1' : ''
    badge.dataset.size = count.length
    if (lastTabCount !== null && lastTabCount !== tabs.length) {
      badge.classList.remove('bump')
      void badge.offsetWidth
      badge.classList.add('bump')
    }
  }
  lastTabCount = tabs.length
  set('switcher-title', tabs.length === 1 ? '1 tab' : `${tabs.length} tabs`)
}

/** The blurred backdrop behind bottom sheets is the last capture of the active tab. */
function setBackdrop(thumbnail) {
  const root = document.documentElement
  if (thumbnail) root.style.setProperty('--thumb', `url("${thumbnail}")`)
  else root.style.removeProperty('--thumb')
}

/** Tab list from the native tab manager. */
globalThis.__nccTabs = (payload) => {
  tabs = payload.tabs || []
  activeTabId = payload.active || ''

  const active = tabs.find((tab) => tab.id === activeTabId)
  if (active) {
    activeUrl = active.url || activeUrl
    activeTitle = active.title || ''
    setBackdrop(active.thumbnail)
  } else {
    activeUrl = ''
    activeTitle = ''
    setBackdrop(null)
  }

  for (const id of Object.keys(progressByTab)) {
    if (!tabs.some((tab) => tab.id === id)) delete progressByTab[id]
  }

  renderCounts()
  renderPill()
  void refreshSecurity()
  if (panel === 'menu') renderMenu()

  if (panel === 'switcher') {
    if (tabs.length === 0) {
      panel = 'home'
      applyLayout()
    } else {
      renderTabGrid()
    }
  }
}

/** Events from the native content surface. */
globalThis.__nccContent = (state) => {
  const id = state.tab

  if (state.type === 'loading') progressByTab[id] = progressByTab[id] ?? 8
  if (state.type === 'progress') {
    if (state.value >= 100) delete progressByTab[id]
    else progressByTab[id] = state.value
  }

  if (state.type === 'loaded') {
    delete progressByTab[id]
    recordVisit(state.url, state.title)
  }

  if (state.type === 'failed' || state.type === 'blocked' || state.type === 'rejected') {
    delete progressByTab[id]
  }

  if (state.type === 'icon') {
    if (state.url && state.icon) saveIcon(displayAddress(state.url), state.icon)
    if (panel === 'home') renderHome()
    if (panel === 'switcher') renderTabGrid()
    return
  }

  if (state.type === 'find') {
    updateFindCount(state.current, state.total)
    return
  }

  if (id === activeTabId && state.url && state.type !== 'progress') {
    activeUrl = state.url
    if (state.title) activeTitle = state.title
    void refreshSecurity()
  }

  renderPill()
}

globalThis.__nccContentReady = () => {
  set('bridge', 'ok (content bridge)')
}

/** The system back gesture asks the shell first; `true` means it was handled here. */
globalThis.__nccBack = () => {
  if (signerRequest) return true
  if (findOpen) {
    closeFind()
    return true
  }
  if (panel !== 'home') {
    goBackPanel()
    return true
  }
  return false
}

/* ───────────────────────────── Panels ───────────────────────────── */

/** Every full-window surface is the shell expanded over the page. */
function showPanel(name) {
  if (!content) return
  if (findOpen) closeFind()
  panel = name
  pendingFocus = null
  content.expand(true)

  if (name === 'switcher') renderTabGrid()
  if (name === 'menu') renderMenu()
  if (name === 'info') void loadInfo()
  if (name === 'signer-settings') void loadPermissions()
  if (name === 'relays') void loadRelays()
  if (name === 'search') void loadSearch()
  if (name === 'security') void loadSecurity()
  if (name === 'appearance') renderAppearanceSub()
  if (name === 'history') renderHistory()
  if (name === 'bookmarks') renderBookmarks()
  if (name === 'downloads') loadDownloads()
  if (name === 'identity') {
    void refreshIdentity()
    void refreshBunker()
  }
  if (name === 'home') renderHome()

  applyLayout()
}

function closePanel() {
  panel = 'home'
  newTabMode = false
  if (tabs.length > 0 && !signerRequest) content?.expand(false)
  applyLayout()
}

function goBackPanel() {
  const parent = PANEL_PARENT[panel]
  if (parent) showPanel(parent)
  else closePanel()
}

function applyLayout() {
  const compact = window.innerHeight < 200
  document.body.classList.toggle('compact', compact)
  byId('bar').hidden = !compact
  byId('strip-main').hidden = findOpen
  byId('strip-find').hidden = !findOpen

  for (const name of PANELS) {
    const element = byId(name)
    if (element) element.hidden = compact || panel !== name
  }
  byId('signer').hidden = compact || !signerRequest

  if (!compact && panel === 'home') renderHome()

  if (!compact && pendingFocus === 'omnibox') {
    pendingFocus = null
    const input = byId('address')
    input.focus()
    input.select()
  }

  if (compact && pendingFocus === 'find') {
    pendingFocus = null
    byId('find-input').focus()
  }
}

/* ───────────────────────────── New tab page ───────────────────────────── */

function shortcutEntries() {
  const seen = new Set()
  const out = []
  for (const entry of [...readList(BOOKMARKS_KEY), ...readList(HISTORY_KEY)]) {
    if (seen.has(entry.address)) continue
    seen.add(entry.address)
    out.push(entry)
    if (out.length >= 8) break
  }
  if (out.length === 0) out.push({ address: DEFAULT_ADDRESS, title: 'Zapstore' })
  return out
}

/* ───────────────────────────── Profile (kind 0) ───────────────────────────── */

const PROFILE_KEY = 'ncc.profiles'
const PROFILE_TTL = 6 * 60 * 60 * 1000
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** `npub1…` to the 64-character hex key. The checksum is not needed to read one. */
function npubToHex(npub) {
  const text = String(npub || '').toLowerCase()
  if (!text.startsWith('npub1')) return null
  const data = [...text.slice(5, -6)].map((char) => BECH32.indexOf(char))
  if (data.length === 0 || data.includes(-1)) return null

  let acc = 0
  let bits = 0
  const out = []
  for (const value of data) {
    acc = (acc << 5) | value
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
    acc &= (1 << bits) - 1
  }
  return out.length === 32 ? out.map((byte) => byte.toString(16).padStart(2, '0')).join('') : null
}

function readProfiles() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(PROFILE_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function saveProfile(hex, profile) {
  const profiles = readProfiles()
  profiles[hex] = { ...profile, at: Date.now() }
  try {
    globalThis.localStorage?.setItem(PROFILE_KEY, JSON.stringify(profiles))
  } catch {
    // Not persisted; it is asked for again next launch.
  }
}

/** Only https images: a profile is written by someone else and shown as-is. */
function safePicture(url) {
  try {
    return new URL(url).protocol === 'https:' ? url : ''
  } catch {
    return ''
  }
}

/** Newest kind 0 for a key, asked of the user's own relays. */
function queryProfile(hex, relays) {
  return new Promise((resolve) => {
    const urls = relays.filter((url) => /^wss?:\/\//i.test(url)).slice(0, 5)
    if (urls.length === 0) return resolve(null)

    let best = null
    let remaining = urls.length
    const sockets = []
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const socket of sockets) {
        try {
          socket.close()
        } catch {
          // Already closed.
        }
      }
      resolve(best)
    }
    const timer = setTimeout(finish, 6000)

    for (const url of urls) {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        if (--remaining === 0) finish()
      }

      let socket
      try {
        socket = new WebSocket(url)
      } catch {
        settle()
        continue
      }
      sockets.push(socket)

      const sub = `p${Math.random().toString(36).slice(2, 8)}`
      socket.onopen = () => socket.send(JSON.stringify(['REQ', sub, { kinds: [0], authors: [hex], limit: 1 }]))
      socket.onmessage = (message) => {
        try {
          const data = JSON.parse(message.data)
          if (data[0] === 'EVENT' && data[2]?.kind === 0 && data[2].pubkey === hex) {
            if (!best || data[2].created_at > best.created_at) best = data[2]
          }
          if (data[0] === 'EOSE') settle()
        } catch {
          // Not a frame we understand.
        }
      }
      socket.onerror = settle
      socket.onclose = settle
    }
  })
}

let profile = null

/** Show what is cached straight away, then refresh it if it is stale. */
async function loadProfile() {
  const hex = npubToHex(identity?.npub)
  if (!hex || !identity?.unlocked) {
    profile = null
    renderHomeIdentity()
    return
  }

  const cached = readProfiles()[hex]
  profile = cached || null
  renderHomeIdentity()
  if (cached && Date.now() - cached.at < PROFILE_TTL) return

  const event = await queryProfile(hex, browserSettings?.relays || [])
  if (!event || npubToHex(identity?.npub) !== hex) return

  try {
    const meta = JSON.parse(event.content)
    saveProfile(hex, {
      name: String(meta.display_name || meta.name || '').slice(0, 60),
      picture: safePicture(meta.picture)
    })
    profile = readProfiles()[hex]
    renderHomeIdentity()
  } catch {
    // A profile that is not JSON is ignored; the app icon stays.
  }
}

function renderHomeIdentity() {
  const text = byId('home-identity-text')
  const mark = byId('brand-mark')
  if (!identity) return

  text.textContent = !identity.initialised
    ? 'Set up your identity'
    : identity.unlocked
      ? `${profile?.name ? `${profile.name} · ` : 'Unlocked · '}${shortId(identity.npub)}`
      : `Locked · ${shortId(identity.npub)}`

  const signedIn = identity.initialised && identity.unlocked
  const picture = signedIn ? profile?.picture : ''
  const key = `${signedIn}|${picture}|${profile?.name || ''}`
  if (mark.dataset.key === key) return
  mark.dataset.key = key

  mark.classList.toggle('is-avatar', signedIn)
  mark.textContent = ''

  const fallback = () => {
    mark.textContent = ''
    mark.appendChild(avatar(profile?.name || identity.npub || 'N'))
  }

  if (!signedIn) {
    const image = document.createElement('img')
    image.src = 'app-icon.png'
    image.alt = ''
    image.draggable = false
    mark.appendChild(image)
  } else if (picture) {
    const image = document.createElement('img')
    image.alt = ''
    image.draggable = false
    image.referrerPolicy = 'no-referrer'
    image.addEventListener('error', fallback)
    image.src = picture
    mark.appendChild(image)
  } else {
    fallback()
  }
}

function renderHome() {
  renderHomeIdentity()
  const container = byId('shortcuts')
  container.textContent = ''

  const entries = shortcutEntries()
  const suggested = readList(BOOKMARKS_KEY).length + readList(HISTORY_KEY).length === 0
  set('shortcuts-label', suggested ? 'Suggested' : 'Shortcuts')

  for (const entry of entries) {
    const label = labelFor(entry)
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'tile'
    const name = document.createElement('span')
    name.textContent = label
    tile.append(avatar(label, '', entry.address), name)
    tile.addEventListener('click', () => void submit(entry.address, { newTab: newTabMode }))
    container.appendChild(tile)
  }
}

/* ───────────────────────────── Omnibox ───────────────────────────── */

function openOmnibox({ newTab = false } = {}) {
  if (!content) return
  newTabMode = newTab
  panel = 'omnibox'
  pendingFocus = 'omnibox'
  byId('address').value = newTab || !activeUrl ? '' : displayAddress(activeUrl)
  byId('omni-error').hidden = true
  byId('omni-clear').hidden = byId('address').value === ''
  renderSuggestions('')
  content.expand(true)
  applyLayout()
}

function suggestionRow(entry, { kind, onClick, iconName }) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'sug'

  if (iconName) {
    const bubble = document.createElement('span')
    bubble.className = 'sug-icon'
    bubble.appendChild(icon(iconName))
    row.appendChild(bubble)
  } else {
    row.appendChild(avatar(labelFor(entry), 'sm', entry.address))
  }

  const text = document.createElement('span')
  text.className = 'row-text'
  const title = document.createElement('b')
  title.textContent = entry.primary ?? labelFor(entry)
  const detail = document.createElement('small')
  detail.textContent = entry.secondary ?? entry.address
  text.append(title, detail)
  row.appendChild(text)

  if (kind) {
    const mark = icon(kind, 'chev')
    row.appendChild(mark)
  }

  row.addEventListener('click', onClick)
  return row
}

function renderSuggestions(query) {
  const list = byId('omni-list')
  list.textContent = ''
  const q = query.trim()

  if (q) {
    const kind = classifyInput(q)
    const row =
      kind === 'address'
        ? suggestionRow(
            { primary: `Open ${q}`, secondary: 'Nostr address' },
            { iconName: 'globe', onClick: () => void submitOmnibox() }
          )
        : kind === 'external'
          ? suggestionRow(
              { primary: `Open ${q}`, secondary: 'Opens in your device browser' },
              { iconName: 'globe', onClick: () => void submitOmnibox() }
            )
          : suggestionRow(
              { primary: `Search for “${q}”`, secondary: 'Opens in your device browser' },
              { iconName: 'search', onClick: () => void submitOmnibox() }
            )
    list.appendChild(row)
  }

  const bookmarks = readList(BOOKMARKS_KEY).map((entry) => ({ ...entry, starred: true }))
  const seen = new Set()
  const pool = []
  for (const entry of [...bookmarks, ...readList(HISTORY_KEY)]) {
    if (seen.has(entry.address)) continue
    seen.add(entry.address)
    pool.push(entry)
  }

  const needle = q.toLowerCase()
  const matches = pool
    .filter((entry) => !needle || `${entry.title} ${entry.address}`.toLowerCase().includes(needle))
    .slice(0, needle ? 8 : 10)

  if (matches.length > 0) {
    if (!needle) {
      const label = document.createElement('p')
      label.className = 'section-label'
      label.textContent = 'Bookmarks and recent'
      list.appendChild(label)
    }
    for (const entry of matches) {
      list.appendChild(
        suggestionRow(entry, {
          kind: 'arrow-up-left',
          onClick: () => void submit(entry.address, { newTab: newTabMode })
        })
      )
    }
  } else if (!q) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'Type an npub, an ncc:// or nsite:// address, or a search.'
    list.appendChild(empty)
  }
}

async function submitOmnibox() {
  await submit(byId('address').value, { newTab: newTabMode })
}

/** Open whatever was typed or tapped. Errors surface under the field. */
async function submit(text, { newTab = false } = {}) {
  const result = await navigate(text, { newTab })
  if (result?.error) {
    const error = byId('omni-error')
    error.textContent = result.error
    error.hidden = false
    if (panel !== 'omnibox') openOmnibox({ newTab })
    byId('address').value = text
    return
  }
  if (result?.ok) {
    panel = 'home'
    newTabMode = false
  }
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

/**
 * Accept what a person actually pastes: `ncc://npub…/service`, `npub…/service`,
 * a hex key, or a bare key for the default service.
 */
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

function targetUrl(input, port) {
  if (/^nsite:/i.test(input)) return nsiteTarget(input, port)

  const parsed = parseAddress(input)
  if (parsed.error) return { error: parsed.error }
  return { url: `http://${parsed.pubkey}.${parsed.service}.localhost:${port}/` }
}

/** Resolve and open. Returns `{ ok }` or `{ error }`. */
async function navigate(text, { newTab = false } = {}) {
  const input = text.trim()
  if (!input) return { error: 'Enter an address or a search.' }

  const kind = classifyInput(input)
  if (kind !== 'address') {
    const url =
      kind === 'search'
        ? searchUrl(input)
        : /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
          ? input
          : `https://${input}`
    // Clearnet is a page like any other: it loads in a tab instead of punting to the
    // system browser, which is what the desktop build has always done.
    if (content) {
      if (newTab && tabs.length > 0) content.openNew(url)
      else content.open(url)
    } else {
      globalThis.open?.(url, '_blank', 'noopener')
    }
    return { ok: true }
  }

  if (!proxyPort) return { error: 'The local proxy is not running.' }

  let target = targetUrl(input, proxyPort)

  // For a site, whether a `d`-like segment is a name or a path depends on what is
  // published, so ask the proxy instead of guessing here.
  if (/^nsite:/i.test(input) && !target.error) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/__ncc/route?u=${encodeURIComponent(input)}`
      )
      if (response.ok) target = await response.json()
    } catch {
      // Fall back to the local guess; the proxy will answer 404 if it is wrong.
    }
  }

  if (target.error) return { error: target.error }

  if (content) {
    if (newTab && tabs.length > 0) content.openNew(target.url)
    else content.open(target.url)
    return { ok: true }
  }

  void probe(target.url)
  return { ok: true }
}

/** Without the native bridge there is no tab to load into; prove the proxy instead. */
async function probe(url) {
  const started = performance.now()
  try {
    const response = await fetch(url, { cache: 'no-store' })
    const body = await response.text()
    const elapsed = Math.round(performance.now() - started)
    set('bridge', `${response.status} in ${elapsed} ms — ${summarise(body).slice(0, 80)}`)
  } catch (error) {
    set('bridge', `fetch failed: ${error?.message ?? error}`)
  }
}

/* ───────────────────────────── Tab switcher ───────────────────────────── */

function renderTabGrid() {
  const grid = byId('tab-grid')
  grid.textContent = ''

  for (const tab of tabs) {
    const label = tab.title || labelFor({ address: displayAddress(tab.url || ''), title: '' }) || 'New tab'

    const card = document.createElement('div')
    card.className = tab.active ? 'tab-card active' : 'tab-card'
    card.setAttribute('role', 'button')
    card.tabIndex = 0

    const head = document.createElement('div')
    head.className = 'tab-head'
    head.appendChild(avatar(label, 'xs', displayAddress(tab.url || '')))
    const title = document.createElement('span')
    title.textContent = label
    head.appendChild(title)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tab-close'
    close.setAttribute('aria-label', `Close ${label}`)
    close.appendChild(icon('close'))
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      content?.closeTab(tab.id)
    })
    head.appendChild(close)
    card.appendChild(head)

    if (tab.thumbnail) {
      const image = document.createElement('img')
      image.className = 'tab-thumb'
      image.src = tab.thumbnail
      image.alt = ''
      card.appendChild(image)
    } else {
      const blank = document.createElement('div')
      blank.className = 'tab-thumb tab-blank'
      blank.appendChild(icon('globe'))
      card.appendChild(blank)
    }

    const open = () => {
      panel = 'home'
      content?.select(tab.id)
      // `select` on the active tab is a no-op natively, so collapse explicitly.
      if (tab.id === activeTabId) content?.expand(false)
      applyLayout()
    }
    card.addEventListener('click', open)
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') open()
    })

    grid.appendChild(card)
  }

  if (tabs.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.style.gridColumn = '1 / -1'
    empty.textContent = 'No open tabs.'
    grid.appendChild(empty)
  }
}

/* ───────────────────────────── Menu ───────────────────────────── */

function renderMenu() {
  const hasPage = tabs.length > 0 && activeUrl !== ''
  const address = hasPage ? displayAddress(activeUrl) : ''
  const active = tabs.find((tab) => tab.id === activeTabId)

  byId('menu-forward').disabled = !active?.canGoForward
  byId('menu-reload').disabled = !hasPage
  byId('menu-share').disabled = !hasPage
  byId('menu-bookmark').disabled = !hasPage
  byId('menu-find').setAttribute('aria-disabled', String(!hasPage))
  byId('menu-copy').setAttribute('aria-disabled', String(!hasPage))
  byId('menu-desktop').setAttribute('aria-disabled', String(!hasPage))
  byId('menu-close').setAttribute('aria-disabled', String(tabs.length === 0))
  byId('menu-desktop-switch').checked = !!active?.desktop

  const marked = hasPage && isBookmarked(address)
  byId('menu-bookmark').classList.toggle('on', marked)
  set('menu-bookmark-label', marked ? 'Bookmarked' : 'Bookmark')
}

function wireMenu() {
  const act = (id, fn) =>
    byId(id).addEventListener('click', () => {
      if (byId(id).disabled || byId(id).getAttribute('aria-disabled') === 'true') return
      fn()
    })

  act('menu-forward', () => {
    content.forward()
    closePanel()
  })
  act('menu-reload', () => {
    content.reload()
    closePanel()
  })
  act('menu-bookmark', () => {
    toggleBookmark(displayAddress(activeUrl), activeTitle)
    renderMenu()
  })
  act('menu-share', () => {
    content.share(displayAddress(activeUrl))
    closePanel()
  })
  act('menu-new', () => openOmnibox({ newTab: true }))
  act('menu-find', () => {
    closePanel()
    openFind()
  })
  act('menu-copy', () => {
    content.copy(displayAddress(activeUrl))
    closePanel()
  })
  act('menu-bookmarks', () => showPanel('bookmarks'))
  act('menu-history', () => showPanel('history'))
  act('menu-settings', () => showPanel('settings'))
  act('menu-close', () => {
    const id = activeTabId
    closePanel()
    content.closeTab(id)
  })

  byId('menu-desktop-switch').addEventListener('change', (event) => {
    content.setDesktopMode(event.target.checked)
    closePanel()
  })
  byId('menu-desktop').addEventListener('click', (event) => {
    if (event.target.id !== 'menu-desktop-switch' && byId('menu-desktop').getAttribute('aria-disabled') === 'true') {
      event.preventDefault()
    }
  })
}

/* ───────────────────────────── Sheets ───────────────────────────── */

/** Tap the dimmed area, or drag the grab handle down, to dismiss a bottom sheet. */
function wireSheet(overlayId, onClose) {
  const overlay = byId(overlayId)
  const card = overlay.querySelector('.sheet-card')

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) onClose()
  })

  const grab = overlay.querySelector('.grab')
  if (!grab) return

  let startY = null
  let delta = 0

  grab.addEventListener('touchstart', (event) => {
    startY = event.touches[0].clientY
    delta = 0
    card.style.transition = 'none'
  })

  grab.addEventListener('touchmove', (event) => {
    if (startY === null) return
    delta = Math.max(0, event.touches[0].clientY - startY)
    card.style.transform = `translateY(${delta}px)`
  })

  const end = () => {
    if (startY === null) return
    startY = null
    card.style.transition = 'transform 0.18s var(--ease)'
    if (delta > 90) {
      onClose()
    }
    card.style.transform = ''
  }
  grab.addEventListener('touchend', end)
  grab.addEventListener('touchcancel', end)
}

/** What the proxy knows about the page in front of you. */
async function loadInfo() {
  const head = byId('info-head')
  const body = byId('info-body')
  head.textContent = ''
  body.textContent = ''

  const message = (text) => {
    const line = document.createElement('p')
    line.className = 'empty'
    line.textContent = text
    body.appendChild(line)
  }

  if (!activeUrl) {
    message('No page is open.')
    return
  }

  message('Loading…')

  try {
    const data = await fetchInfo(activeUrl)
    renderInfo(data)
  } catch (error) {
    body.textContent = ''
    message(String(error))
  }
}

function renderInfo(data) {
  const head = byId('info-head')
  const body = byId('info-body')
  head.textContent = ''
  body.textContent = ''

  const state = classifySecurity(data)
  securityCache.set(new URL(activeUrl).host, state)
  securityState = state

  const badge = document.createElement('span')
  badge.className = 'info-badge'
  badge.dataset.state = state
  badge.appendChild(icon(SECURITY[state].lock))
  const text = document.createElement('div')
  const title = document.createElement('b')
  title.textContent = SECURITY[state].label
  const detail = document.createElement('small')
  detail.textContent = SECURITY[state].detail
  text.append(title, detail)
  head.append(badge, text)
  renderPill()

  if (!data.error) body.appendChild(buildChecks(data))

  const section = (name) => {
    const heading = document.createElement('p')
    heading.className = 'info-section'
    heading.textContent = name
    body.appendChild(heading)
  }

  const row = (label, value) => {
    if (value === undefined || value === null || value === '') return
    const line = document.createElement('div')
    line.className = 'info-row'
    const term = document.createElement('dt')
    term.textContent = label
    const definition = document.createElement('dd')
    definition.textContent = String(value)
    line.append(term, definition)
    body.appendChild(line)
  }

  const when = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString() : null)

  if (data.error) {
    section('Problem')
    row('Error', data.error)
    return
  }

  section(data.kind === 'nsite' ? 'Site' : 'Service')
  row('Kind', data.kind)
  row('Identity', data.pubkey)
  if (data.service) row('Service', data.service)
  if (data.site) row('Site', data.site)
  if (data.title) row('Title', data.title)

  section('Record')
  if (data.dTag) row('d tag', data.dTag)
  row('Event', data.event)
  row('Updated', when(data.updated))
  row('Expires', when(data.expires))
  if (data.paths) row('Files', data.paths)

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
    for (const server of data.servers) row('Server', server)
  }
}

/** The Shields-style list: what was verified, how it was reached, who may sign. */
function buildChecks(data) {
  const wrap = document.createElement('div')
  wrap.className = 'checks'

  const add = (kind, title, detail, action) => {
    const row = document.createElement('div')
    row.className = 'check-row'
    const mark = document.createElement('span')
    mark.className = `check-mark ${kind === 'ok' ? '' : kind}`.trim()
    mark.appendChild(icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'warn' : 'info'))
    const text = document.createElement('span')
    text.className = 'row-text'
    const strong = document.createElement('b')
    strong.textContent = title
    const small = document.createElement('small')
    small.textContent = detail
    text.append(strong, small)
    row.append(mark, text)
    if (action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn tonal'
      button.textContent = action.label
      button.addEventListener('click', action.onClick)
      row.appendChild(button)
    }
    wrap.appendChild(row)
    return row
  }

  const endpoints = data.endpoints || []
  if (data.kind === 'nsite') {
    add('ok', 'Files verified', 'Each file is checked against its published hash')
  } else {
    add('ok', 'Locator found', `Signed record for ${shortId(String(data.pubkey || ''))}`)
    if (endpoints.some((e) => e.pinned)) add('ok', 'Certificate pinned', "Matches the key in the locator, not a CA")
    else if (endpoints.some((e) => /https/i.test(e.protocol || ''))) add('ok', 'Encrypted', 'HTTPS endpoint')
    else if (endpoints.length > 0) add('warn', 'Not encrypted', 'Only cleartext HTTP is offered')
    add(
      endpoints.some((e) => e.family === 'onion') ? 'ok' : 'neutral',
      'Transport',
      endpoints.some((e) => e.family === 'onion') ? 'Onion endpoint available' : 'Clearnet only'
    )
  }

  const signerRow = add('neutral', 'Signer', 'Asks before every signature')
  void (async () => {
    try {
      const trusted = await invoke('signer_permissions')
      const mine = trusted.find((entry) => data.pubkey && entry.includes(String(data.pubkey).slice(0, 12)))
      if (!mine) return
      signerRow.querySelector('small').textContent = 'Signs without asking'
      signerRow.querySelector('.check-mark').className = 'check-mark warn'
      const revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.className = 'btn tonal'
      revoke.textContent = 'Revoke'
      revoke.addEventListener('click', async () => {
        await invoke('signer_revoke', { service: mine })
        signerRow.querySelector('small').textContent = 'Asks before every signature'
        signerRow.querySelector('.check-mark').className = 'check-mark neutral'
        revoke.remove()
      })
      signerRow.appendChild(revoke)
    } catch {
      // Signer list unavailable; the default line stands.
    }
  })()

  return wrap
}

/* ───────────────────────────── Find in page ───────────────────────────── */

function openFind() {
  if (!content || tabs.length === 0) return
  findOpen = true
  pendingFocus = 'find'
  byId('find-input').value = ''
  updateFindCount(0, 0)
  applyLayout()
}

function closeFind() {
  findOpen = false
  content?.clearFind()
  byId('find-input').blur()
  applyLayout()
}

function updateFindCount(current, total) {
  set('find-count', byId('find-input').value && total >= 0 ? `${total === 0 ? 0 : current}/${total}` : '')
}

function wireFind() {
  const input = byId('find-input')
  input.addEventListener('input', () => {
    if (findTimer) clearTimeout(findTimer)
    findTimer = setTimeout(() => {
      if (input.value) content.find(input.value)
      else {
        content.clearFind()
        updateFindCount(0, 0)
      }
    }, 150)
  })
  byId('strip-find').addEventListener('submit', (event) => {
    event.preventDefault()
    if (input.value) content.findNext(true)
  })
  byId('find-next').addEventListener('click', () => content.findNext(true))
  byId('find-prev').addEventListener('click', () => content.findNext(false))
  byId('find-close').addEventListener('click', () => closeFind())
}

/* ───────────────────────────── History and bookmarks ───────────────────────────── */

function listEntry(entry, { onRemove } = {}) {
  const row = document.createElement('div')
  row.className = 'list-row'

  const open = suggestionRow(
    {
      ...entry,
      secondary: entry.at ? `${entry.address} · ${new Date(entry.at).toLocaleDateString()}` : entry.address
    },
    { onClick: () => void submit(entry.address, { newTab: false }) }
  )
  row.appendChild(open)

  if (onRemove) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ib'
    remove.setAttribute('aria-label', 'Remove')
    remove.appendChild(icon('trash'))
    remove.addEventListener('click', onRemove)
    row.appendChild(remove)
  }
  return row
}

function emptyState(container, text) {
  const empty = document.createElement('p')
  empty.className = 'empty'
  empty.textContent = text
  container.appendChild(empty)
}

function renderHistory() {
  const container = byId('history-list')
  container.textContent = ''

  const entries = readList(HISTORY_KEY)
  byId('history-clear').hidden = entries.length === 0
  if (entries.length === 0) {
    emptyState(container, 'No history yet.')
    return
  }

  for (const entry of entries) container.appendChild(listEntry(entry))
}

function renderBookmarks() {
  const container = byId('bookmarks-list')
  container.textContent = ''

  const entries = readList(BOOKMARKS_KEY)
  if (entries.length === 0) {
    emptyState(container, 'No bookmarks yet. Use the star in the menu to add one.')
    return
  }

  for (const entry of entries) {
    container.appendChild(
      listEntry(entry, { onRemove: () => toggleBookmark(entry.address, entry.title) })
    )
  }
}

/* ───────────────────────────── Settings ───────────────────────────── */

async function invoke(command, args) {
  return globalThis.__TAURI__.core.invoke(command, args)
}

async function loadRelays() {
  const input = byId('relays-input')
  byId('relays-error').textContent = ''
  try {
    browserSettings = await invoke('browser_settings')
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
    browserSettings = await invoke('settings_set_relays', { relays })
    browserSettings = await invoke('settings_set_gossip', { value: byId('gossip').checked })
    byId('relays-input').value = browserSettings.relays.join('\n')
    byId('relays-error').textContent = 'Saved. The next lookup uses these.'
  } catch (error) {
    byId('relays-error').textContent = String(error)
  }
}

const ENGINE_NAMES = {
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave Search',
  startpage: 'Startpage',
  google: 'Google',
  bing: 'Bing',
  searx: 'SearXNG',
  custom: 'Custom'
}

function renderSearchSub() {
  set('sub-search', ENGINE_NAMES[browserSettings?.searchEngine || 'duckduckgo'])
}

function renderAppearanceSub() {
  const theme = byId('theme').value
  const position = byId('bar-position').value
  set(
    'sub-appearance',
    `${theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark' : 'Light'} · ${position} toolbar`
  )
}

async function loadSearch() {
  try {
    browserSettings = await invoke('browser_settings')
    byId('search-engine').value = browserSettings.searchEngine
    byId('search-custom').value = browserSettings.searchEngineCustom
    byId('search-custom-label').textContent =
      browserSettings.searchEngine === 'custom' ? 'Template with %s' : 'SearXNG instance'
    renderSearchSub()
  } catch (error) {
    byId('search-error').textContent = String(error)
  }
}

async function saveSearch() {
  try {
    browserSettings = await invoke('settings_set_search', {
      engine: byId('search-engine').value,
      custom: byId('search-custom').value.trim()
    })
    byId('search-error').textContent = 'Saved.'
    renderSearchSub()
  } catch (error) {
    byId('search-error').textContent = String(error)
  }
}

async function loadSecurity() {
  try {
    browserSettings = await invoke('browser_settings')
    byId('https-mode').value = browserSettings.httpsMode
    byId('warn-insecure').checked = browserSettings.warnInsecure
  } catch (error) {
    byId('security-error').textContent = String(error)
  }
}

async function saveSecurity() {
  try {
    browserSettings = await invoke('settings_set_https', {
      mode: byId('https-mode').value,
      warn: byId('warn-insecure').checked
    })
    byId('security-error').textContent = 'Saved.'
  } catch (error) {
    byId('security-error').textContent = String(error)
  }
}

async function loadPermissions() {
  const container = byId('permissions')
  container.textContent = ''

  try {
    const services = await invoke('signer_permissions')
    if (services.length === 0) {
      container.style.display = 'none'
      const list = byId('permissions').parentElement
      let empty = list.querySelector('.empty')
      if (!empty) {
        empty = document.createElement('p')
        empty.className = 'empty'
        list.appendChild(empty)
      }
      empty.textContent = 'No service is trusted yet.'
      return
    }

    container.style.display = ''
    byId('permissions').parentElement.querySelector('.empty')?.remove()

    for (const service of services) {
      const row = document.createElement('div')
      row.className = 'row'
      const text = document.createElement('span')
      text.className = 'row-text'
      const title = document.createElement('b')
      title.textContent = service
      const detail = document.createElement('small')
      detail.textContent = 'Does not ask again this session'
      text.append(title, detail)

      const revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.className = 'btn text'
      revoke.textContent = 'Revoke'
      revoke.addEventListener('click', async () => {
        await invoke('signer_revoke', { service })
        await loadPermissions()
      })
      row.append(text, revoke)
      container.appendChild(row)
    }
  } catch (error) {
    container.style.display = 'none'
    emptyState(byId('permissions').parentElement, String(error))
  }
}

/** Theme is a shell setting: it only changes this document's colour scheme. */
function applyTheme(value) {
  const root = document.documentElement
  if (value === 'light' || value === 'dark') root.dataset.theme = value
  else delete root.dataset.theme

  try {
    globalThis.localStorage?.setItem('ncc.theme', value)
  } catch {
    // Not persisted; the system default applies next launch.
  }
  byId('theme').value = value
  renderAppearanceSub()
}

/** Toolbar position is a user setting; the default matches Firefox and Brave. */
function applyBarPosition(position) {
  const value = position === 'top' ? 'top' : 'bottom'
  byId('bar-position').value = value
  document.body.dataset.bar = value
  try {
    globalThis.localStorage?.setItem('ncc.bar', value)
  } catch {
    // Not persisted.
  }
  content?.setBarPosition(value)
  renderAppearanceSub()
}

/* ───────────────────────────── Identity and signer ───────────────────────────── */

function renderIdentity(status) {
  identity = status
  const state = byId('identity-state')

  if (!status.initialised) {
    state.textContent = 'No identity on this device yet.'
    set('sub-identity', 'None yet — create or import one')
  } else if (status.unlocked) {
    state.textContent = `Unlocked: ${status.npub}`
    set('sub-identity', `Unlocked · ${shortId(status.npub)}`)
  } else {
    state.textContent = `Locked: ${status.npub}`
    set('sub-identity', `Locked · ${shortId(status.npub)}`)
  }

  // The keystore holds the key, so there is nothing to type. Only a file from before
  // the keystore still needs its passphrase, and only once.
  const legacy = status.envelope === 'legacy'
  for (const id of ['passphrase', 'unlock-passphrase']) {
    const input = byId(id)
    const label = input?.closest('label')
    if (label) label.hidden = !legacy
  }
  set(
    'identity-store',
    legacy
      ? 'This identity is stored with a passphrase. Enter it once and it moves to the device keystore.'
      : 'Your key is wrapped by the device keystore; there is no passphrase to remember.'
  )

  byId('identity-setup').hidden = status.initialised
  byId('identity-locked').hidden = !status.initialised || status.unlocked
  byId('identity-lock').hidden = !status.unlocked

  // Only an identity stored on this device can stay unlocked; there is nothing to
  // keep open otherwise.
  byId('keep-unlocked-row').hidden = !status.initialised
  byId('keep-unlocked').checked = browserSettings?.keepUnlocked === true
  renderHomeIdentity()
  void loadProfile()
}

/**
 * A remote signer replaces the local key for signing: the bunker holds the key and
 * asks its own user, so nothing is approved here.
 */
async function refreshBunker() {
  const state = byId('bunker-state')
  if (!state) return

  try {
    const info = await invoke('bunker_status')
    if (info?.configured) {
      state.textContent = info.npub
        ? `Signing through a remote signer as ${info.npub}. Approve requests on the signer.`
        : 'A remote signer is connected; waiting for it to answer.'
      byId('bunker-disconnect').hidden = false
    } else {
      state.textContent = 'None. The identity above signs on this device.'
      byId('bunker-disconnect').hidden = true
    }
  } catch (error) {
    state.textContent = `Could not read the remote signer: ${error}`
  }
}

async function refreshIdentity() {
  try {
    renderIdentity(await invoke('identity_status'))
  } catch (error) {
    byId('identity-state').textContent = `Identity unavailable: ${error}`
  }
}

function identityFailure(error) {
  byId('identity-error').textContent = String(error)
}

async function setupIdentity(tauri) {
  byId('identity-create').addEventListener('click', async () => {
    try {
      renderIdentity(await invoke('identity_create'))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-import').addEventListener('click', async () => {
    const secret = byId('nsec').value.trim()
    if (!secret) {
      identityFailure('Paste an nsec first.')
      return
    }
    try {
      renderIdentity(await invoke('identity_import', { secret }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-unlock').addEventListener('click', async () => {
    const legacy = identity?.envelope === 'legacy'
    try {
      renderIdentity(
        await invoke(
          'identity_unlock',
          legacy ? { passphrase: byId('unlock-passphrase').value } : {}
        )
      )
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('keep-unlocked').addEventListener('change', async () => {
    const enabled = byId('keep-unlocked').checked
    try {
      const status = await invoke('settings_set_keep_unlocked', { enabled })
      browserSettings = await invoke('browser_settings')
      renderIdentity(status)
    } catch (error) {
      // Refused, so say why and put the switch back where it was.
      byId('identity-error').textContent = String(error)
      byId('keep-unlocked').checked = !enabled
    }
  })

  byId('bunker-connect').addEventListener('click', async () => {
    const url = byId('bunker-url').value.trim()
    const note = byId('bunker-error')
    if (!url) {
      note.textContent = 'Paste the bunker:// link from your signer first.'
      return
    }

    note.textContent = 'Connecting… the signer may ask you to approve this app.'
    try {
      const info = await invoke('bunker_connect', { url })
      byId('bunker-url').value = ''
      note.textContent = info?.npub ? `Connected as ${info.npub}.` : 'Connected.'
      await refreshBunker()
    } catch (error) {
      note.textContent = String(error)
    }
  })

  byId('bunker-disconnect').addEventListener('click', async () => {
    const note = byId('bunker-error')
    try {
      await invoke('bunker_disconnect')
      note.textContent = 'Disconnected.'
      await refreshBunker()
    } catch (error) {
      note.textContent = String(error)
    }
  })

  byId('identity-lock').addEventListener('click', async () => {
    renderIdentity(await invoke('identity_lock'))
  })

  await tauri.event.listen('ncc:signer', (event) => showSigner(event.payload))
  await refreshIdentity()
}

/** What a request means in words, instead of the raw NIP-07 method name. */
function describeSignerMethod(request) {
  const kind = request.kind ? ` (kind ${request.kind})` : ''
  switch (request.method) {
    case 'getPublicKey':
      return 'Wants to read your public key'
    case 'signEvent':
      return `Wants you to sign an event${kind}`
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return 'Wants to encrypt a message with your key'
    case 'nip04.decrypt':
    case 'nip44.decrypt':
      return 'Wants to decrypt a message with your key'
    default:
      return `${request.method}${kind}`
  }
}

/** A page is waiting on an answer, so take the window until it has one. */
function showSigner(request) {
  signerRequest = request
  signerDeadline = Date.now() + 120_000
  if (signerTimer) clearInterval(signerTimer)
  signerTimer = setInterval(tickSigner, 1000)

  byId('signer-service').textContent = request.service
  byId('signer-method').textContent = describeSignerMethod(request)
  byId('signer-preview').textContent = request.preview || '(nothing to show)'
  byId('signer-preview').hidden = !request.preview
  byId('signer-remember').checked = false
  byId('signer-bar').style.width = '100%'
  tickSigner()
  content?.expand(true)
  applyLayout()
}

function tickSigner() {
  const left = Math.max(0, Math.round((signerDeadline - Date.now()) / 1000))
  byId('signer-countdown').textContent =
    left > 0 ? `Denied automatically in ${left}s` : 'Expired — the request was denied.'
  byId('signer-bar').style.width = `${(left / 120) * 100}%`

  if (left === 0) {
    finishSigner()
  }
}

function finishSigner() {
  if (signerTimer) clearInterval(signerTimer)
  signerTimer = null
  signerRequest = null
  if (panel === 'home' && tabs.length > 0) content?.expand(false)
  applyLayout()
}

async function answerSigner(allow) {
  if (!signerRequest) return
  const request = signerRequest
  const remember = byId('signer-remember').checked
  finishSigner()

  try {
    await invoke('signer_respond', {
      id: request.id,
      allow,
      remember,
      service: request.service
    })
  } catch {
    // The request is gone either way; the page sees its own error.
  }
}

/* ───────────────────────────── Strip gestures ───────────────────────────── */

/** Swipe the address pill sideways to move between tabs, as Brave does. */
function wireSwipe() {
  const target = byId('bar-address')
  let startX = 0
  let startY = 0
  let tracking = false

  target.addEventListener('touchstart', (event) => {
    startX = event.touches[0].clientX
    startY = event.touches[0].clientY
    tracking = true
  })

  target.addEventListener('touchend', (event) => {
    if (!tracking) return
    tracking = false
    const dx = event.changedTouches[0].clientX - startX
    const dy = event.changedTouches[0].clientY - startY
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2 && tabs.length > 1) {
      // Swallow the click this gesture would otherwise end in.
      target.dataset.swiped = '1'
      setTimeout(() => delete target.dataset.swiped, 400)
      if (dx < 0) content.next()
      else content.prev()
    }
  })
}

/* ───────────────────────────── Boot ───────────────────────────── */

function wireChrome() {
  for (const button of document.querySelectorAll('[data-panel]')) {
    button.addEventListener('click', () => showPanel(button.dataset.panel))
  }
  for (const button of document.querySelectorAll('[data-back]')) {
    button.addEventListener('click', () => goBackPanel())
  }

  // The strip's arrow takes the same native path as the system back gesture.
  byId('bar-back').addEventListener('click', () => {
    if (typeof content.navigateBack === 'function') content.navigateBack()
    else content.back()
  })
  byId('bar-reload').addEventListener('click', () => {
    if (progressByTab[activeTabId] !== undefined) {
      content.stop()
      delete progressByTab[activeTabId]
      renderPill()
    } else {
      content.reload()
    }
  })
  byId('bar-address').addEventListener('click', (event) => {
    if (event.currentTarget.dataset.swiped) return
    openOmnibox({ newTab: false })
  })
  byId('bar-info').addEventListener('click', () => {
    if (activeUrl) showPanel('info')
  })
  byId('bar-tabs').addEventListener('click', () => showPanel('switcher'))
  byId('bar-menu').addEventListener('click', () => showPanel('menu'))

  byId('home-search').addEventListener('click', () => openOmnibox({ newTab: tabs.length > 0 }))

  byId('omni-back').addEventListener('click', () => closePanel())
  byId('omni-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void submitOmnibox()
  })
  byId('address').addEventListener('input', () => {
    const value = byId('address').value
    byId('omni-clear').hidden = value === ''
    byId('omni-error').hidden = true
    renderSuggestions(value)
  })
  byId('omni-clear').addEventListener('click', () => {
    byId('address').value = ''
    byId('omni-clear').hidden = true
    renderSuggestions('')
    byId('address').focus()
  })

  byId('switcher-new').addEventListener('click', () => openOmnibox({ newTab: true }))
  byId('switcher-close-all').addEventListener('click', () => {
    for (const tab of [...tabs]) content.closeTab(tab.id)
    // Native collapses nothing here: closing the last tab expands the shell itself.
    panel = 'home'
    applyLayout()
  })

  wireMenu()
  wireFind()
  wireSwipe()
  wireSheet('menu', () => closePanel())
  wireSheet('info', () => closePanel())

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
      await invoke('clear_cache')
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
  byId('theme').addEventListener('change', (event) => applyTheme(event.target.value))

  byId('signer-allow').addEventListener('click', () => void answerSigner(true))
  byId('signer-deny').addEventListener('click', () => void answerSigner(false))

  window.addEventListener('resize', applyLayout)
}

async function main() {
  applyTheme(globalThis.localStorage?.getItem('ncc.theme') || 'system')
  applyBarPosition(globalThis.localStorage?.getItem('ncc.bar') || 'bottom')
  renderCounts()
  renderPill()
  applyLayout()

  if (content) wireChrome()

  const tauri = globalThis.__TAURI__

  if (!tauri) {
    set('bridge', 'missing (plain WebView, not the shell)')
    set('about-proxy', 'unavailable')
    return
  }

  set('bridge', content ? 'ok (content bridge)' : 'ok')

  try {
    const version = await tauri.app.getVersion()
    set('about-version', version)
    set('sub-about', `Version ${version}`)
  } catch {
    // Informational only.
  }

  try {
    proxyPort = await tauri.core.invoke('proxy_port')
  } catch (error) {
    set('about-proxy', `invoke failed: ${error?.message ?? error}`)
    return
  }

  set('about-proxy', proxyPort ? `127.0.0.1:${proxyPort}` : 'not started')

  // Tabs resolve `ncc://` links and downloads through the proxy, and a clearnet page
  // cannot tell them the port.
  if (proxyPort && content && typeof content.setProxyPort === 'function') {
    content.setProxyPort(proxyPort)
  }

  try {
    await setupIdentity(tauri)
  } catch {
    // Identity is optional for browsing.
  }

  try {
    browserSettings = await tauri.core.invoke('browser_settings')
    renderSearchSub()
  } catch {
    // Fall back to the defaults above.
  }

  // Relays are only known now, so a profile asked for during identity setup waits.
  void loadProfile()

  void refreshSecurity()
}

void main()
