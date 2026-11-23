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
import { closeMoneroWallet, handleNwcPageRequest, loadWallet, wireWallet } from './wallet.js'
import './downloads.js'
import { addressParts, avatar, displayAddress, icon, iconKey, labelFor, saveIcon, setIcon, shortId } from './address.js'
import { createSync } from './sync.js'
import { createProfile } from './profile.js'
import { createHome } from './home.js'
import { createSecurity } from './security.js'
import { createSecurityInfo } from './security-info.js'
import { createPasswords } from './passwords.js'
import { createPaymentCards } from './payment-cards.js'
import { createIdentity } from './identity.js'

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
/** Normal, private and Tor tabs never share a list, a colour or a close-all. */
const KINDS = ['normal', 'private', 'tor']

const KIND_INFO = {
  normal: { label: 'Normal', icon: 'tab', one: 'tab', newLabel: 'New tab', short: 'New tab', note: '' },
  private: {
    label: 'Private',
    icon: 'eye-off',
    one: 'private tab',
    info: 'This tab leaves no history or saved icons. Cookies are shared with normal tabs on this device, and your connection is not hidden.',
    newLabel: 'New private tab',
    short: 'New private',
    note: 'Private tabs leave no history or saved icons. Cookies are shared with normal tabs, and your connection is not hidden.'
  },
  tor: {
    label: 'Tor',
    icon: 'onion',
    one: 'Tor tab',
    info: 'This tab is loaded through Tor. It leaves no history or saved icons.',
    newLabel: 'New Tor tab',
    short: 'New Tor',
    note: 'Tor tabs open .onion and https:// addresses, and search through an onion search engine, all through Tor.'
  }
}

/** What a private tab can honestly promise depends on whether the WebView can give it
 * a session of its own; `applyProfileNotices` swaps these in once native says so. */
let privateSessionDetail = 'No history or saved icons. Cookies are shared with normal tabs'

function applyProfileNotices() {
  if (!content || typeof content.profilesSupported !== 'function') return
  let supported = false
  try {
    supported = Boolean(content.profilesSupported())
  } catch {
    supported = false
  }
  if (!supported) return

  KIND_INFO.private.note =
    'Private tabs leave no history or saved icons. Their cookies and site data are kept apart from normal tabs and discarded when the last private tab closes. Your connection is not hidden.'
  KIND_INFO.private.info =
    'This tab leaves no history or saved icons. Its cookies and site data are kept apart from normal tabs and discarded when the last private tab closes. Your connection is not hidden.'
  KIND_INFO.tor.info =
    'This tab is loaded through Tor. It leaves no history or saved icons, and its cookies and site data are discarded when the last Tor tab closes.'
  privateSessionDetail = 'Own cookies and storage, discarded when the last private tab closes'
}

const kindOf = (tab) => (tab && KINDS.includes(tab.kind) ? tab.kind : 'normal')

/** Which kind the tab switcher is showing. */
let switcherKind = 'normal'

let tabs = []
let activeTabId = ''
let panel = 'home'
let proxyPort = null
let privatePort = null
let torPort = null
let activeUrl = ''
let activeTitle = ''
let browserSettings = null
let signerTimer = null
let signerDeadline = 0
let newTabMode = false
let privateMode = false
let torMode = false
let pendingFocus = null
let findOpen = false
let findTimer = null
let identity = null
let nccSearchEnabled = false

function updateNccSearchButton() {
  byId('home-nccsearch').hidden = !nccSearchEnabled
}

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
  'nccsearch',
  'security',
  'tor',
  'passwords',
  'wallet',
  'sync',
  'password-fill',
  'password-save',
  'share-nostr',
  'password-edit',
  'payment-cards',
  'payment-picker',
  'payment-auth-choice',
  'payment-save',
  'payment-edit',
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
  nccsearch: 'home',
  security: 'settings',
  tor: 'settings',
  passwords: 'settings',
  'payment-cards': 'settings',
  'payment-edit': 'payment-cards',
  'payment-picker': 'home',
  'payment-auth-choice': 'payment-picker',
  'payment-save': 'home',
  wallet: 'settings',
  sync: 'settings',
  'password-edit': 'passwords',
  storage: 'settings',
  identity: 'settings',
  'signer-settings': 'settings',
  about: 'settings'
}

const OVERLAYS = new Set(['menu', 'info'])

const DEFAULT_ADDRESS = 'ncc://npub1zapstdvcqpkwqh0sq3685kw87mqlruv9zuck5kxk0m9eazlsd5xq2juxuw'

const HISTORY_KEY = 'ncc.history'
const BOOKMARKS_KEY = 'ncc.bookmarks'
/** Removed bookmarks, kept for 90 days so a removal reaches the other devices. */
const BOOKMARKS_REMOVED_KEY = 'ncc.bookmarks.removed'
/** Visits at or before this time were cleared; sync spreads that to the other devices. */
const HISTORY_CLEARED_KEY = 'ncc.history.cleared'
const HISTORY_LIMIT = 500

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

function localChanged(category) {
  syncFeature?.localChanged(category)
}

function recordVisit(url, title) {
  if (!url) return
  const address = displayAddress(url)
  const all = readList(HISTORY_KEY)
  const previous = all.find((entry) => entry.address === address)
  const entries = all.filter((entry) => entry.address !== address)
  entries.unshift({
    address,
    title: title || previous?.title || '',
    at: Date.now(),
    visits: (previous?.visits || 0) + 1
  })
  writeList(HISTORY_KEY, entries.slice(0, HISTORY_LIMIT))
  localChanged('history')
}

function clearHistory() {
  writeList(HISTORY_KEY, [])
  writeNumber(HISTORY_CLEARED_KEY, Date.now())
  localChanged('history')
}

function isBookmarked(address) {
  return readList(BOOKMARKS_KEY).some((entry) => entry.address === address)
}

function toggleBookmark(address, title) {
  const entries = readList(BOOKMARKS_KEY)
  const removed = readList(BOOKMARKS_REMOVED_KEY).filter((entry) => entry.address !== address)
  const index = entries.findIndex((entry) => entry.address === address)
  const now = Date.now()
  if (index >= 0) {
    const [gone] = entries.splice(index, 1)
    removed.push({ address, createdAt: gone.at || now, deletedAt: now })
  } else {
    entries.unshift({ address, title: title || '', at: now, updatedAt: now })
  }
  writeList(BOOKMARKS_KEY, entries)
  writeList(BOOKMARKS_REMOVED_KEY, removed)
  renderBookmarks()
  localChanged('bookmarks')
  return index < 0
}

function writeNumber(key, value) {
  try {
    globalThis.localStorage?.setItem(key, String(value))
  } catch {
    // Storage can be unavailable; the watermark just is not remembered.
  }
}

function readNumber(key) {
  try {
    const value = Number(globalThis.localStorage?.getItem(key) || 0)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/* ───────────────────────────── Security state ───────────────────────────── */

let securityState = 'unknown'

async function refreshSecurity() {
  const url = activeUrl
  const state = url ? await security.securityFor(url) : 'unknown'
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
    // The kind chip takes room in the pill, so the identity gives up a few characters
    // rather than the service name.
    const tight = kindOf(tabs.find((tab) => tab.id === activeTabId)) !== 'normal'
    id.textContent = tight ? parts.id.replace(/^(.{6}).*…(.{3})$/, '$1…$2') : parts.id
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

  const active = tabs.find((tab) => tab.id === activeTabId)
  const kind = kindOf(active)
  document.body.dataset.kind = kind
  const chip = byId('pill-kind')
  chip.hidden = kind === 'normal'
  if (kind !== 'normal') {
    setIcon(chip.querySelector('svg'), KIND_INFO[kind].icon)
    chip.setAttribute('aria-label', `${KIND_INFO[kind].label} tab`)
    chip.title = KIND_INFO[kind].note
  }

  const lock = byId('bar-info')
  const state = activeUrl ? securityState : 'unknown'
  lock.dataset.state = state
  setIcon(lock.querySelector('svg'), security.SECURITY[state].lock)

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
  if (panel === 'switcher') renderKindTabs()
}

/** The blurred backdrop behind bottom sheets is the last capture of the active tab. */
function setBackdrop(thumbnail) {
  const root = document.documentElement
  if (thumbnail) root.style.setProperty('--thumb', `url("${thumbnail}")`)
  else root.style.removeProperty('--thumb')
}

/* ───────────────────────────── Keeping tabs across restarts ───────────────────────────── */

const TABS_KEY = 'ncc.tabs'
let tabsRestored = false
let saveTabsTimer = null

/**
 * The proxy listens on a new port every launch, so a saved `http://<host>.localhost:<port>/`
 * would point nowhere. The port is replaced by a placeholder on the way out and by the
 * current one on the way back in. Clearnet addresses carry no port of ours.
 */
function portable(url) {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('.localhost')) return url
    return `${parsed.protocol}//${parsed.hostname}:{port}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return ''
  }
}

/** Normal tabs only. A private or Tor tab is never written down, not even its address. */
function writeTabs() {
  if (!tabsRestored) return
  const saved = tabs
    .filter((tab) => kindOf(tab) === 'normal' && tab.url)
    .slice(0, 30)
    .map((tab) => ({
      url: portable(tab.url),
      title: String(tab.title || '').slice(0, 120),
      active: tab.id === activeTabId
    }))
    .filter((entry) => entry.url)
  try {
    globalThis.localStorage?.setItem(TABS_KEY, JSON.stringify(saved))
  } catch {
    // Storage unavailable: the tabs simply are not remembered.
  }
}

function saveTabs() {
  if (saveTabsTimer) clearTimeout(saveTabsTimer)
  saveTabsTimer = setTimeout(() => {
    writeTabs()
    localChanged('tabs')
  }, 300)
}

/**
 * Reopen what was open. Native keeps all but the active tab parked, so nothing loads
 * until it is picked and a long list does not hit the relays at launch.
 */
function restoreTabs() {
  let saved = []
  try {
    saved = JSON.parse(globalThis.localStorage?.getItem(TABS_KEY) || '[]')
  } catch {
    saved = []
  }
  tabsRestored = true

  if (!Array.isArray(saved) || !proxyPort) return
  if (!content || typeof content.restoreTab !== 'function' || tabs.length > 0) return

  const entries = saved.filter((entry) => entry && typeof entry.url === 'string').slice(0, 30)
  const hasActive = entries.some((entry) => entry.active)
  entries.forEach((entry, index) => {
    content.restoreTab(
      entry.url.replace('{port}', String(proxyPort)),
      String(entry.title || ''),
      hasActive ? Boolean(entry.active) : index === 0
    )
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) writeTabs()
})

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

  saveTabs()
}

/** Events from the native content surface. */
globalThis.__nccContent = (state) => {
  const id = state.tab

  if (state.type === 'nwc-request') return
  if (state.type === 'webauthn-request') {
    void passwordFeature.handleWebauthnRequest(state)
    return
  }

  if (state.type === 'loading') progressByTab[id] = progressByTab[id] ?? 8
  if (state.type === 'progress') {
    if (state.value >= 100) delete progressByTab[id]
    else progressByTab[id] = state.value
  }

  if (state.type === 'loaded') {
    delete progressByTab[id]
    // A private tab leaves no history, and no icon either: what it browsed is the
    // user's business, not this device's.
    if (!isPrivateTab(id)) recordVisit(state.url, state.title)
  }

  if (state.type === 'failed' || state.type === 'blocked' || state.type === 'rejected') {
    delete progressByTab[id]
  }

  // A login the native hook saw submitted. The secret goes straight into the vault
  // command; the prompt below holds only an id.
  if (state.type === 'capture') {
    void passwordFeature.handlePasswordCapture(state)
    return
  }
  if (state.type === 'payment-detected') { void paymentFeature.detect(state); return }
  if (state.type === 'payment-capture') { void paymentFeature.capture(state); return }

  if (state.type === 'filled') {
    // The fill runs after the panel closes, so a miss is reported where the user can
    // act on it rather than as a silent no-op.
    if (state.ok === false) {
      passwordFeature.reportFillFailure()
    }
    return
  }

  // An onion link followed from a normal tab: the shell picks the kind of tab that
  // can actually load it.
  if (state.type === 'onion' && state.url) {
    void navigate(state.url, { newTab: true })
    return
  }

  if (state.type === 'icon') {
    if (state.url && state.icon && !isPrivateTab(id)) saveIcon(displayAddress(state.url), state.icon)
    if (panel === 'home') homeFeature.renderHome()
    if (panel === 'switcher') renderTabGrid()
    return
  }

  if (state.type === 'cleared') {
    securityInfo.siteClearComplete(state)
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

globalThis.__nccWalletRequest = (request) => {
  void handleNwcPageRequest(request).then(
    (result) => window.NccContent?.resolveNwc(request.tab, request.requestId, JSON.stringify({ ok: true, result })),
    (error) => window.NccContent?.resolveNwc(request.tab, request.requestId, JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }))
  )
}

/** A link opened from another app (we are a registered browser): open it in a new tab. */
function openExternalLink() {
  if (!content || typeof content.takeLink !== 'function') return
  const link = content.takeLink()
  if (!link) return
  // NCC and nsite addresses need the local proxy; navigate() resolves them.
  if (/^(ncc|nsite):/i.test(link)) { void navigate(link, { newTab: true }); return }
  // Straight to a new tab: `tabs` may not have caught up with the restored ones yet.
  // Onion links still go through navigate() so they land in a Tor tab.
  if (/^https?:\/\/[^/?#]*\.onion(?:[:/?#]|$)/i.test(link)) void navigate(link, { newTab: true })
  else content.openNew(link)
}
globalThis.__nccOpenLink = openExternalLink

globalThis.__nccContentReady = () => {
  set('bridge', 'ok (content bridge)')
}

/** The system back gesture asks the shell first; `true` means it was handled here. */
globalThis.__nccBack = () => {
  if (identityFeature.hasSignerRequest()) return true
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
  if (panel === 'nccsearch' && name !== 'nccsearch') {
    // Unload the document, not just the attribute: Android WebView can keep a
    // <video> inside a hidden iframe audible after `removeAttribute('src')`.
    // loadNccSearch() sets a real src again on the next visit.
    byId('nccsearch-frame').src = 'about:blank'
  }
  if (panel === 'wallet' && name !== 'wallet') void closeMoneroWallet()
  if (findOpen) closeFind()
  panel = name
  pendingFocus = null
  content.expand(true)

  if (name === 'switcher') {
    switcherKind = kindOf(tabs.find((tab) => tab.id === activeTabId))
    renderTabGrid()
  }
  if (name === 'menu') renderMenu()
  if (name === 'info') void securityInfo.loadInfo()
  if (name === 'signer-settings') void loadPermissions()
  if (name === 'relays') void loadRelays()
  if (name === 'search') void loadSearch()
  if (name === 'nccsearch') void loadNccSearch()
  if (name === 'security') void loadSecurity()
  if (name === 'tor') void loadTor()
  if (name === 'passwords') void passwordFeature.loadPasswords()
  if (name === 'payment-cards') void paymentFeature.load()
  if (name === 'wallet') void loadWallet()
  if (name === 'sync') syncFeature.renderSync()
  if (name === 'password-fill') void passwordFeature.renderPasswordFill()
  if (name === 'password-save') passwordFeature.renderPasswordSave()
  if (name === 'share-nostr') renderShareNostr()
  if (name === 'password-edit') passwordFeature.renderPasswordEdit()
  if (name === 'appearance') renderAppearanceSub()
  if (name === 'history') renderHistory()
  if (name === 'bookmarks') renderBookmarks()
  if (name === 'downloads') loadDownloads()
  if (name === 'identity') {
    void identityFeature.refreshIdentity()
    void identityFeature.refreshBunker()
  }
  if (name === 'home') homeFeature.renderHome()

  applyLayout()
}

function closePanel() {
  panel = 'home'
  newTabMode = false
  privateMode = false
  torMode = false
  if (tabs.length > 0 && !identityFeature.hasSignerRequest()) content?.expand(false)
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
  byId('signer').hidden = compact || !identityFeature.hasSignerRequest()

  if (!compact && panel === 'home') homeFeature.renderHome()

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

/* ───────────────────────────── Omnibox ───────────────────────────── */

function openOmnibox({ newTab = false, private: isPrivate = false, tor = false } = {}) {
  if (!content) return

  // Editing the address of a private or Tor tab stays in that kind. Otherwise a search
  // typed in a Tor tab would open in a normal one, which is exactly what the tab is for
  // avoiding.
  if (!newTab && !isPrivate && !tor) {
    const current = kindOf(tabs.find((tab) => tab.id === activeTabId))
    isPrivate = current === 'private'
    tor = current === 'tor'
  }

  newTabMode = newTab
  privateMode = isPrivate
  torMode = tor

  // Asking for a Tor tab is the earliest sign that Tor will be needed, and building
  // the first circuit is the slow part. Starting now means it is further along by the
  // time an address has been typed. Nothing contacts the network before this point.
  if (tor && typeof invoke === 'function') void invoke('tor_prepare').catch(() => {})
  panel = 'omnibox'
  pendingFocus = 'omnibox'
  byId('address').value = newTab || !activeUrl ? '' : displayAddress(activeUrl)
  byId('omni-error').hidden = true
  byId('omni-clear').hidden = byId('address').value === ''
  const kind = tor ? 'tor' : isPrivate ? 'private' : 'normal'
  byId('omnibox').dataset.kind = kind
  const note = byId('omni-kind')
  note.hidden = kind === 'normal'
  note.textContent = ''
  if (kind !== 'normal') {
    const strong = document.createElement('strong')
    strong.textContent = KIND_INFO[kind].newLabel
    const text = document.createElement('span')
    text.append(strong, document.createTextNode(` — ${KIND_INFO[kind].note}`))
    note.append(icon(KIND_INFO[kind].icon), text)
  }
  byId('address').placeholder = tor ? 'Search or enter a .onion or https:// address' : 'Search or enter address'
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
      onionUrl(q)
        ? suggestionRow(
            { primary: `Open ${q}`, secondary: 'Onion address · opens in a Tor tab' },
            { iconName: 'onion', onClick: () => void submitOmnibox() }
          )
        : kind === 'address'
        ? suggestionRow(
            { primary: `Open ${q}`, secondary: 'Nostr address' },
            { iconName: 'globe', onClick: () => void submitOmnibox() }
          )
        : torMode && torWebUrl(q)
          ? suggestionRow(
              { primary: `Open ${q}`, secondary: 'Website · loaded through Tor' },
              { iconName: 'onion', onClick: () => void submitOmnibox() }
            )
        : torMode && kind === 'external'
          ? suggestionRow(
              { primary: `Can't open ${q}`, secondary: 'Tor tabs open .onion and https:// addresses and searches only' },
              { iconName: 'onion', onClick: () => void submitOmnibox() }
            )
          : torMode
            ? suggestionRow(
                {
                  primary: `Search for “${q}”`,
                  secondary: torSearch().swapped
                    ? `${torSearch().wanted} has no onion service · using DuckDuckGo over Tor`
                    : `${torSearch().name} over Tor`
                },
                { iconName: 'onion', onClick: () => void submitOmnibox() }
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
  await submit(byId('address').value, {
    newTab: newTabMode,
    private: privateMode,
    tor: torMode
  })
}

/** Open whatever was typed or tapped. Errors surface under the field. */
async function submit(text, { newTab = false, private: isPrivate = privateMode, tor = torMode } = {}) {
  const result = await navigate(text, { newTab, private: isPrivate, tor })
  if (result?.error) {
    const error = byId('omni-error')
    error.textContent = result.error
    error.hidden = false
    if (panel !== 'omnibox') openOmnibox({ newTab, private: isPrivate, tor })
    byId('address').value = text
    return
  }
  if (result?.ok) {
    panel = 'home'
    newTabMode = false
    privateMode = false
    torMode = false
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
 * Engines that publish an onion service the proxy can reach. A Tor tab cannot use a
 * clearnet engine at all, so an engine that is not here falls back to DuckDuckGo, the
 * one every Tor client already trusts. Brave Search has an onion too, but it lives on
 * a subdomain (`search.<onion>`) and the Tor listener only serves bare onion hosts.
 */
const ONION_SEARCH = {
  duckduckgo: {
    name: 'DuckDuckGo',
    template: 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=%s'
  }
}

/** The engine a Tor tab searches with, and whether it had to be swapped. */
function torSearch() {
  const engine = browserSettings?.searchEngine || 'duckduckgo'
  const custom = (browserSettings?.searchEngineCustom || '').trim()

  // An engine the user pointed at their own onion service is used as given.
  if ((engine === 'custom' || engine === 'searx') && custom && onionUrl(custom.replace('%s', 'x'))) {
    const template =
      engine === 'custom' ? custom : `${custom.replace(/\/+$/, '')}/search?q=%s`
    return { name: ENGINE_NAMES[engine], template, swapped: false }
  }

  const found = ONION_SEARCH[engine]
  if (found) return { ...found, swapped: false }
  return { ...ONION_SEARCH.duckduckgo, swapped: true, wanted: ENGINE_NAMES[engine] || 'Your engine' }
}

function torSearchUrl(text) {
  return torSearch().template.replace('%s', encodeURIComponent(text))
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
async function navigate(text, { newTab = false, private: isPrivate = false, tor = false } = {}) {
  const input = text.trim()
  if (!input) return { error: 'Enter an address or a search.' }

  // An onion address always belongs in a Tor tab, whether it was typed there or in
  // a normal one. Turning the current tab into a Tor tab is not possible: the kind is
  // fixed when the tab is built, and its listener decides what it may fetch.
  const onion = onionUrl(input) || (tor ? torWebUrl(input) : null)
  if (onion) {
    if (!torPort) return { error: 'Tor is not available in this build.' }

    // Tor starts at launch unless that setting is off; either way this starts it if
    // it is not running, and restarts a route that failed.
    try {
      await invoke('tor_prepare')
    } catch {
      // The status panel explains a missing route; the tab waits for one either way.
    }

    let target = onionTarget(onion, torPort)
    try {
      const response = await fetch(
        `http://127.0.0.1:${torPort}/__ncc/route?u=${encodeURIComponent(onion.href)}`
      )
      if (response.ok) {
        target = await response.json()
      } else {
        const problem = await response.json().catch(() => null)
        return { error: problem?.detail || 'Could not open that onion address.' }
      }
    } catch {
      // Fall back to the local shape; the listener answers or refuses it.
    }

    if (content) {
      if (newTab && tabs.length > 0) content.openNewTor(target.url)
      else content.openTor(target.url)
      return { ok: true }
    }

    void probe(target.url)
    return { ok: true }
  }

  // A Tor tab is onion-only, so refusing here is clearer than an empty page. The
  // refusal is not a preference: fetching clearnet from a Tor tab would reveal the
  // reader's address, which is what the tab exists to avoid.
  if (tor) {
    // A search is fine: it goes to the engine's onion service, never to clearnet.
    if (classifyInput(input) === 'search') {
      return navigate(torSearchUrl(input), { newTab, tor: true })
    }
    return { error: 'A Tor tab opens .onion and https:// addresses and searches only.' }
  }

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
      if (isPrivate) {
        if (newTab && tabs.length > 0) content.openNewPrivate(url)
        else content.openPrivate(url)
      } else if (newTab && tabs.length > 0) {
        content.openNew(url)
      } else {
        content.open(url)
      }
    } else {
      globalThis.open?.(url, '_blank', 'noopener')
    }
    return { ok: true }
  }

  const port = isPrivate ? privatePort : proxyPort
  if (!port) return { error: 'The local proxy is not running.' }

  let target = targetUrl(input, port)

  // For a site, whether a `d`-like segment is a name or a path depends on what is
  // published, so ask the proxy instead of guessing here.
  if (/^nsite:/i.test(input) && !target.error) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/__ncc/route?u=${encodeURIComponent(input)}`
      )
      if (response.ok) target = await response.json()
    } catch {
      // Fall back to the local guess; the proxy will answer 404 if it is wrong.
    }
  }

  if (target.error) return { error: target.error }

  if (content) {
    if (isPrivate) {
      if (newTab && tabs.length > 0) content.openNewPrivate(target.url)
      else content.openPrivate(target.url)
    } else if (newTab && tabs.length > 0) {
      content.openNew(target.url)
    } else {
      content.open(target.url)
    }
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

/** The onion URL a string names, or null. A bare host is accepted; people paste those. */
function onionUrl(value) {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  try {
    const url = new URL(candidate)
    const host = url.hostname.toLowerCase()
    if (!host.endsWith('.onion')) return null
    if (host.length !== 62) return null
    return url
  } catch {
    return null
  }
}

/**
 * An ordinary website a Tor tab may open: `https://` or a bare host name. It is
 * fetched through Tor by the listener, never by the WebView. Plain `http://` is
 * upgraded, since an exit relay would see it.
 */
function torWebUrl(value) {
  const text = value.trim()
  if (/\s/.test(text) || /^(ncc|nsite):/i.test(text)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null
  if (!/^https?:\/\//i.test(text) && classifyInput(text) !== 'external') return null
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    const host = url.hostname.toLowerCase()
    if (host.endsWith('.onion') || !host.includes('.')) return null
    if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null
    if (host.endsWith('.local') || host.endsWith('.localhost')) return null
    url.protocol = 'https:'
    return url
  } catch {
    return null
  }
}

/** The virtual host for an onion URL, when the proxy cannot be asked. */
function onionTarget(url, port) {
  const host = url.hostname.toLowerCase()
  if (!host.endsWith('.onion')) {
    const label = url.port && url.port !== '443' ? `${host}.p${url.port}` : host
    return { url: `http://${label}.tor.localhost:${port}${url.pathname}${url.search}${url.hash}` }
  }
  return { url: `http://${host}.localhost:${port}${url.pathname}${url.search}${url.hash}` }
}

/** Private and Tor tabs both leave nothing behind: no history entry, no saved icon. */
function isPrivateTab(id) {
  const kind = tabs.find((tab) => tab.id === id)?.kind
  return kind === 'private' || kind === 'tor'
}

/** The Normal / Private / Tor switch at the top of the tab switcher. */
function renderKindTabs() {
  const bar = byId('kind-tabs')
  bar.textContent = ''
  const screen = byId('switcher')
  screen.dataset.kind = switcherKind

  for (const kind of KINDS) {
    const count = tabs.filter((tab) => kindOf(tab) === kind).length
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `kind-tab kind-${kind}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(kind === switcherKind))
    button.dataset.kind = kind
    const label = document.createElement('span')
    label.textContent = KIND_INFO[kind].label
    const badge = document.createElement('b')
    badge.textContent = String(count)
    button.append(icon(KIND_INFO[kind].icon), label, badge)
    button.addEventListener('click', () => {
      switcherKind = kind
      renderTabGrid()
    })
    bar.appendChild(button)
  }

  const shown = tabs.filter((tab) => kindOf(tab) === switcherKind).length
  set('switcher-title', `${shown} ${shown === 1 ? KIND_INFO[switcherKind].one : `${KIND_INFO[switcherKind].one}s`}`)
  set('switcher-new-label', KIND_INFO[switcherKind].short)
  byId('switcher-close-all').textContent = 'Close all'
  byId('switcher-close-all').disabled = shown === 0
}

function renderTabGrid() {
  const grid = byId('tab-grid')
  grid.textContent = ''
  renderKindTabs()

  const visible = tabs.filter((tab) => kindOf(tab) === switcherKind)

  for (const tab of visible) {
    const kind = kindOf(tab)
    const label = tab.title || labelFor({ address: displayAddress(tab.url || ''), title: '' }) || 'New tab'

    const card = document.createElement('div')
    card.className = `${tab.active ? 'tab-card active' : 'tab-card'} kind-${kind}`
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', kind === 'normal' ? label : `${label} — ${KIND_INFO[kind].label} tab`)
    card.tabIndex = 0

    const head = document.createElement('div')
    head.className = 'tab-head'
    head.appendChild(avatar(label, 'xs', kind === 'normal' ? displayAddress(tab.url || '') : ''))
    const title = document.createElement('span')
    title.textContent = label
    head.appendChild(title)
    if (kind !== 'normal') {
      const mark = document.createElement('span')
      mark.className = 'tab-kind'
      mark.title = `${KIND_INFO[kind].label} tab`
      mark.appendChild(icon(KIND_INFO[kind].icon))
      head.appendChild(mark)
    }

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

    if (tab.thumbnail && kind === 'normal') {
      const image = document.createElement('img')
      image.className = 'tab-thumb'
      image.src = tab.thumbnail
      image.alt = ''
      card.appendChild(image)
    } else {
      // A private or Tor page is never previewed: the switcher is easy to shoulder-surf
      // and a thumbnail would outlive the tab in the capture cache.
      const blank = document.createElement('div')
      blank.className = 'tab-thumb tab-blank'
      blank.appendChild(icon(kind === 'normal' ? 'globe' : KIND_INFO[kind].icon))
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

  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'kind-empty'
    empty.style.gridColumn = '1 / -1'
    const mark = document.createElement('span')
    mark.className = 'kind-empty-mark'
    mark.appendChild(icon(KIND_INFO[switcherKind].icon))
    const text = document.createElement('p')
    text.textContent =
      switcherKind === 'normal'
        ? 'No open tabs.'
        : `No ${KIND_INFO[switcherKind].one}s open. ${KIND_INFO[switcherKind].note}`
    empty.append(mark, text)
    grid.appendChild(empty)
  }

  syncFeature.renderDeviceTabs(grid)
}

/* ───────────────────────────── Menu ───────────────────────────── */

function renderMenu() {
  const hasPage = tabs.length > 0 && activeUrl !== ''
  const address = hasPage ? displayAddress(activeUrl) : ''
  const active = tabs.find((tab) => tab.id === activeTabId)

  byId('menu-forward').disabled = !active?.canGoForward
  byId('menu-reload').disabled = !hasPage
  byId('menu-share').disabled = !hasPage
  const nostr = shareNostrState(active, hasPage)
  byId('menu-share-nostr').setAttribute('aria-disabled', String(!nostr.ok))
  byId('menu-share-nostr-note').textContent = nostr.ok ? '' : nostr.why
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
  act('menu-home', () => showPanel('home'))
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
  act('menu-share-nostr', () => {
    const active = tabs.find((tab) => tab.id === activeTabId)
    if (!shareNostrState(active, tabs.length > 0 && activeUrl !== '').ok) return
    showPanel('share-nostr')
  })
  act('menu-new', () => openOmnibox({ newTab: true }))
  act('menu-private', () => openOmnibox({ newTab: true, private: true }))
  act('menu-tor', () => openOmnibox({ newTab: true, tor: true }))
  act('menu-passwords', () => showPanel('password-fill'))
  act('menu-wallet', () => showPanel('wallet'))
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

async function checkNccSearchUpdate(manual = false) {
  const status = byId('nccsearch-update-status')
  if (manual) status.textContent = 'Checking…'
  try {
    const version = await invoke('nccsearch_check_update')
    if (!version) {
      if (manual) status.textContent = 'You have the latest version.'
      return
    }
    if (!manual && readSetting('ncc.nccsearch.dismissed-update', '') === version) return
    if (confirm(`nccsearch ${version} is available. Install it now?`)) {
      await invoke('nccsearch_install_update', { version })
      status.textContent = 'Updated. Restart Nostr Navigator to apply it.'
      alert('nccsearch is updated. Restart Nostr Navigator to apply it.')
    } else {
      writeSetting('ncc.nccsearch.dismissed-update', version)
      if (manual) status.textContent = `Update ${version} is available.`
    }
  } catch {
    if (manual) status.textContent = 'Could not check for updates.'
  }
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
  const textSize = readSetting('ncc.text-size', 'default')
  const accent = readSetting('ncc.accent', 'violet')
  set(
    'sub-appearance',
    `${theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark' : 'Light'} · ${textSize} text · ${accent} accent · ${position} toolbar`
  )
}

function readSetting(key, fallback) {
  try {
    return globalThis.localStorage?.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function writeSetting(key, value) {
  try { globalThis.localStorage?.setItem(key, value) } catch { /* preferences are optional */ }
}

function applyChoiceAttribute(attribute, value, choices, key, fallback) {
  const selected = choices.includes(value) ? value : fallback
  if (selected === fallback) delete document.documentElement.dataset[attribute]
  else document.documentElement.dataset[attribute] = selected
  try {
    globalThis.localStorage?.setItem(key, selected)
  } catch {
    // The setting still applies for this run.
  }
  const dataAttribute = attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  for (const button of document.querySelectorAll(`button[data-${dataAttribute}]`)) {
    button.setAttribute('aria-checked', String(button.dataset[attribute] === selected))
  }
  renderAppearanceSub()
}

function applyTextSize(value) {
  applyChoiceAttribute('textSize', value, ['small', 'default', 'large', 'xlarge'], 'ncc.text-size', 'default')
}

function applyAccent(value) {
  applyChoiceAttribute('accent', value, ['blue', 'violet', 'green', 'amber'], 'ncc.accent', 'violet')
}

/** Auto follows the system: gesture navigation already has a swipe-back. */
function applyBackButton(value) {
  const choice = ['auto', 'show', 'hide'].includes(value) ? value : 'auto'
  let gestures = false
  try {
    gestures = choice === 'auto' && content?.isGestureNavigation?.() === true
  } catch {
    gestures = false
  }
  const hidden = choice === 'hide' || gestures
  if (hidden) document.documentElement.dataset.backHidden = 'true'
  else delete document.documentElement.dataset.backHidden
  try {
    globalThis.localStorage?.setItem('ncc.back-button', choice)
  } catch {
    // Applies for this run only.
  }
  for (const button of document.querySelectorAll('button[data-back-button]')) {
    button.setAttribute('aria-checked', String(button.dataset.backButton === choice))
  }
}

function applyDensity(value) {
  applyChoiceAttribute('density', value, ['comfortable', 'compact'], 'ncc.density', 'comfortable')
}

function applyReduceMotion(value) {
  const enabled = value === true || value === 'true'
  document.documentElement.dataset.reduceMotion = String(enabled)
  byId('reduce-motion').checked = enabled
  try {
    globalThis.localStorage?.setItem('ncc.reduce-motion', String(enabled))
  } catch {
    // The setting still applies for this run.
  }
}

async function loadSearch() {
  try {
    browserSettings = await invoke('browser_settings')
    byId('search-engine').value = browserSettings.searchEngine
    byId('search-custom').value = browserSettings.searchEngineCustom
    byId('search-custom-label').textContent =
      browserSettings.searchEngine === 'custom' ? 'Template with %s' : 'SearXNG instance'
    nccSearchEnabled = readSetting('ncc.nccsearch.enabled', 'false') === 'true'
    byId('nccsearch-enabled').checked = nccSearchEnabled
    updateNccSearchButton()
    renderSearchSub()
  } catch (error) {
    byId('search-error').textContent = String(error)
  }
}

async function loadNccSearch() {
  if (!nccSearchEnabled) {
    showPanel('search')
    byId('search-error').textContent = 'Enable local nccsearch in Search settings first.'
    return
  }
  const frame = byId('nccsearch-frame')
  try {
    const [settings, profiles] = await Promise.all([
      invoke('browser_settings'),
      invoke('identity_profiles').catch(() => null)
    ])
    const relays = (settings.relays || []).filter((relay) => /^wss?:\/\//i.test(relay)).slice(0, 6)
    if (!proxyPort) throw new Error('The local page proxy is not ready yet.')
    const url = new URL(`http://nccsearch.localhost:${proxyPort}/`)
    url.searchParams.set('relays', btoa(relays.join(',')))
    const activeId = profiles?.active_id || ''
    const key = activeId.split(':').at(-1)
    if (/^[0-9a-f]{64}$/i.test(key || '')) url.searchParams.set('pubkey', key.toLowerCase())
    frame.src = url.toString()
  } catch (error) {
    byId('search-error').textContent = `Could not open nccsearch: ${error}`
    showPanel('search')
  }
}

async function saveSearch() {
  try {
    browserSettings = await invoke('settings_set_search', {
      engine: byId('search-engine').value,
      custom: byId('search-custom').value.trim()
    })
    nccSearchEnabled = byId('nccsearch-enabled').checked
    writeSetting('ncc.nccsearch.enabled', String(nccSearchEnabled))
    updateNccSearchButton()
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
    byId('protection-level').value = browserSettings.protection?.level || 'standard'
    byId('block-scripts').checked = browserSettings.protection?.blockScripts === true
  } catch (error) {
    byId('security-error').textContent = String(error)
  }
  try {
    renderProtectionFilterStatus(await invoke('protection_filters_status'))
  } catch (error) {
    byId('protection-filter-status').textContent = `Filter list status unavailable: ${String(error)}`
  }
}

function renderProtectionFilterStatus(status) {
  const label = byId('protection-filter-status')
  const button = byId('protection-update-lists')
  if (!label || !button) return
  button.disabled = status.updating === true
  if (status.updating) {
    label.textContent = `Updating lists (${status.loadedLists} of ${status.totalLists} cached)`
    setTimeout(() => {
      void invoke('protection_filters_status').then(renderProtectionFilterStatus).catch(() => {})
    }, 2000)
    return
  }
  const updated = status.updatedAt
    ? ` Most recent list download: ${new Date(status.updatedAt * 1000).toLocaleString()}.`
    : ' No downloaded lists yet; built-in ad rules are active.'
  label.textContent = `${status.loadedLists} of ${status.totalLists} downloaded filter lists active.${updated}${status.error ? ` ${status.error}.` : ''}`
}

async function updateProtectionFilterLists() {
  const button = byId('protection-update-lists')
  const label = byId('protection-filter-status')
  if (button) button.disabled = true
  if (label) label.textContent = 'Updating filter lists…'
  try {
    renderProtectionFilterStatus(await invoke('protection_update_filters'))
  } catch (error) {
    if (button) button.disabled = false
    if (label) label.textContent = `Filter list update failed: ${String(error)}`
  }
}

function torStateText(status) {
  if (!status) return 'Tor is not available in this build.'
  if (status.state === 'ready') {
    return status.kind === 'bundled'
      ? 'Tor is ready, using the bundled client.'
      : `Tor is ready through ${status.proxy || 'a local SOCKS proxy'}.`
  }
  if (status.state === 'starting') {
    return `Connecting to Tor… ${status.percent || 0}%`
  }
  if (status.state === 'failed') {
    return `Tor is not running: ${status.error || 'no reason was reported'}`
  }
  return 'Tor starts when a Tor tab is opened.'
}

async function refreshTorState() {
  const line = byId('tor-state')
  try {
    const status = await invoke('tor_status')
    line.textContent = torStateText(status)
  } catch (error) {
    line.textContent = `Tor status is unavailable: ${error}`
  }
}

async function loadTor() {
  // Looking at this panel is asking about Tor, so it is also a reasonable moment to
  // start it. `prepare` does nothing if a route is already being resolved.
  try {
    await invoke('tor_prepare')
  } catch {
    // Reported below via the status line.
  }

  try {
    browserSettings = await invoke('browser_settings')
    byId('tor-mode').value = browserSettings.torMode === 'local' ? 'local' : 'auto'
    byId('tor-socks').value = browserSettings.torSocks
    byId('tor-on-launch').checked = browserSettings.torOnLaunch !== false
  } catch (error) {
    byId('tor-note').textContent = String(error)
  }
  await refreshTorState()
}

async function saveTor() {
  try {
    browserSettings = await invoke('settings_set_tor', {
      mode: byId('tor-mode').value,
      socks: byId('tor-socks').value.trim()
    })
    browserSettings = await invoke('settings_set_tor_on_launch', {
      value: byId('tor-on-launch').checked
    })
    byId('tor-note').textContent = 'Saved. The new route is used once it is ready.'
    await refreshTorState()
  } catch (error) {
    byId('tor-note').textContent = String(error)
  }
}

/* ───────────────────────────── Passwords ───────────────────────────── */

function activeKind() {
  return tabs.find((tab) => tab.id === activeTabId)?.kind || 'normal'
}

/* ───────────────────────────── Share to Nostr ───────────────────────────── */

/** A public post: normal tabs only, and only with an unlocked identity. */
function shareNostrState(tab, hasPage) {
  if (!hasPage || !tab) return { ok: false, why: 'Open a page first' }
  if (tab.kind !== 'normal') return { ok: false, why: 'Normal tabs only' }
  if (!identity?.initialised || !identity?.unlocked) return { ok: false, why: 'Sign in first' }
  return { ok: true, why: '' }
}

let sharing = false

function renderShareNostr() {
  sharing = false
  byId('share-comment').value = ''
  byId('share-comment').disabled = false
  byId('share-post').disabled = false
  byId('share-post').textContent = 'Post'
  byId('share-note').textContent = ''
  const title = activeTitle ? `${activeTitle}\n` : ''
  byId('share-preview').textContent = `${title}${displayAddress(activeUrl)}`
  byId('share-preview').style.whiteSpace = 'pre-wrap'
  byId('share-who').textContent = `Posts publicly as ${shortId(identity?.npub || '')} to your relays.`
}

async function postShareNostr() {
  if (sharing) return
  const tab = tabs.find((entry) => entry.id === activeTabId)
  if (!shareNostrState(tab, !!activeUrl).ok) return
  sharing = true
  const note = byId('share-note')
  const button = byId('share-post')
  button.disabled = true
  button.textContent = 'Posting…'
  note.textContent = ''
  try {
    const result = await invoke('share_nostr', {
      kind: tab.kind || 'normal',
      url: displayAddress(activeUrl),
      title: activeTitle || '',
      comment: byId('share-comment').value
    })
    if (result.accepted > 0) {
      note.textContent = `Posted to ${result.accepted} of ${result.relays} relays.`
      button.textContent = 'Done'
      byId('share-comment').disabled = true
      setTimeout(() => {
        if (!byId('share-nostr').hidden) closePanel()
      }, 1500)
      return
    }
    note.textContent = `No relay accepted the post${result.error ? `: ${result.error}` : '.'}`
  } catch (error) {
    note.textContent = String(error)
  }
  sharing = false
  button.disabled = false
  button.textContent = 'Retry'
}

async function saveSecurity() {
  try {
    browserSettings = await invoke('settings_set_https', {
      mode: byId('https-mode').value,
      warn: byId('warn-insecure').checked
    })
    browserSettings = await invoke('settings_set_protection', {
      protection: {
        ...browserSettings.protection,
        level: byId('protection-level').value,
        blockScripts: byId('block-scripts').checked
      }
    })
    if (activeUrl) content.reload()
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

  byId('switcher-new').addEventListener('click', () =>
    openOmnibox({ newTab: true, private: switcherKind === 'private', tor: switcherKind === 'tor' })
  )
  byId('switcher-close-all').addEventListener('click', () => {
    // Only the tabs of the kind on screen: closing private tabs must never take
    // normal ones with them, or the other way round.
    const closing = tabs.filter((tab) => kindOf(tab) === switcherKind)
    for (const tab of closing) content.closeTab(tab.id)
    if (closing.length === tabs.length) {
      // Native expands the shell itself when the last tab goes.
      panel = 'home'
      applyLayout()
    } else {
      renderTabGrid()
    }
  })

  wireMenu()
  wireWallet()
  wireFind()
  wireSwipe()
  wireSheet('menu', () => closePanel())
  wireSheet('info', () => closePanel())

  byId('relays-save').addEventListener('click', () => void saveRelays())
  byId('search-save').addEventListener('click', () => void saveSearch())
  byId('nccsearch-update-check').addEventListener('click', () => void checkNccSearchUpdate(true))
  byId('nccsearch-enabled').addEventListener('change', () => {
    nccSearchEnabled = byId('nccsearch-enabled').checked
    updateNccSearchButton()
    writeSetting('ncc.nccsearch.enabled', String(nccSearchEnabled))
  })
  byId('search-engine').addEventListener('change', () => {
    byId('search-custom-label').textContent =
      byId('search-engine').value === 'custom' ? 'Template with %s' : 'SearXNG instance'
  })
  byId('security-save').addEventListener('click', () => void saveSecurity())
  byId('protection-update-lists').addEventListener('click', () => void updateProtectionFilterLists())
  byId('tor-save').addEventListener('click', () => void saveTor())
  byId('tor-refresh').addEventListener('click', () => void refreshTorState())

  byId('vault-unlock').addEventListener('click', () => void passwordFeature.unlockVault())
  byId('vault-lock').addEventListener('click', () => void passwordFeature.lockVault())
  byId('vault-search').addEventListener('input', () => void passwordFeature.renderVaultList())
  byId('vault-add').addEventListener('click', () => passwordFeature.openNewLogin(''))
  byId('vault-save-config').addEventListener('click', () => void passwordFeature.saveVaultConfig())
  byId('fill-add').addEventListener('click', () => passwordFeature.openNewLogin(displayAddress(activeUrl)))
  byId('fill-manage').addEventListener('click', () => showPanel('passwords'))
  paymentFeature.wire()
  byId('edit-save').addEventListener('click', () => void passwordFeature.saveEdits())
  byId('edit-delete').addEventListener('click', () => void passwordFeature.deleteEditing())
  byId('edit-generate').addEventListener('click', () => void passwordFeature.generateIntoEdit())
  byId('save-accept').addEventListener('click', () => void passwordFeature.respondSave('save'))
  byId('save-never').addEventListener('click', () => void passwordFeature.respondSave('never'))
  byId('save-dismiss').addEventListener('click', () => void passwordFeature.respondSave('dismiss'))
  byId('share-post').addEventListener('click', () => void postShareNostr())

  // Coming back to the app is a reasonable moment to pull the relay copy; the vault
  // throttles it to once every 30 seconds.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void invoke('vault_focus').catch(() => {})
    if (panel === 'passwords') void passwordFeature.loadPasswords()
  })
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
    clearHistory()
    renderHistory()
  })

  byId('bar-position').addEventListener('change', (event) => applyBarPosition(event.target.value))
  byId('theme').addEventListener('change', (event) => applyTheme(event.target.value))
  document.querySelectorAll('[data-text-size]').forEach((button) => {
    button.addEventListener('click', () => applyTextSize(button.dataset.textSize))
  })
  document.querySelectorAll('[data-accent]').forEach((button) => {
    button.addEventListener('click', () => applyAccent(button.dataset.accent))
  })
  document.querySelectorAll('[data-density]').forEach((button) => {
    button.addEventListener('click', () => applyDensity(button.dataset.density))
  })
  document.querySelectorAll('[data-back-button]').forEach((button) => {
    button.addEventListener('click', () => applyBackButton(button.dataset.backButton))
  })
  byId('reduce-motion').addEventListener('change', (event) => applyReduceMotion(event.target.checked))
  byId('appearance-reset').addEventListener('click', () => {
    applyTheme('system')
    applyBarPosition('bottom')
    applyTextSize('default')
    applyAccent('violet')
    applyDensity('comfortable')
    applyBackButton('auto')
    applyReduceMotion(false)
  })

  byId('signer-allow').addEventListener('click', () => void identityFeature.answerSigner(true))
  byId('signer-deny').addEventListener('click', () => void identityFeature.answerSigner(false))

  window.addEventListener('resize', applyLayout)
}

const passwordFeature = createPasswords({
  content, invoke, byId, set, displayAddress, showPanel, closePanel, goBackPanel, activeKind,
  getTabs: () => tabs,
  getActiveUrl: () => activeUrl,
  getActiveTabId: () => activeTabId
})
const paymentFeature = createPaymentCards({ content, invoke, byId, showPanel, closePanel,
  getTabs: () => tabs, getActiveUrl: () => activeUrl, getActiveTabId: () => activeTabId })
globalThis.__nccDeviceCredential = (ok) => { passwordFeature.deviceCredentialReply(ok); paymentFeature.credentialReply(ok) }

const security = createSecurity({ getProxyPort: () => proxyPort })

const securityInfo = createSecurityInfo({
  byId, icon, displayAddress, security, invoke, content, confirm, renderPill, activeKind,
  KIND_INFO,
  getActiveUrl: () => activeUrl,
  getTabs: () => tabs,
  getActiveTabId: () => activeTabId,
  getPrivateSessionDetail: () => privateSessionDetail,
  setSecurityState: (value) => { securityState = value }
})

const profileFeature = createProfile({
  invoke, byId, avatar, shortId,
  getIdentity: () => identity,
  getBrowserSettings: () => browserSettings
})

const homeFeature = createHome({
  readList, writeList, set, byId, labelFor, avatar, submit,
  renderHomeIdentity: () => profileFeature.renderHomeIdentity(),
  getNewTabMode: () => newTabMode,
  HOME_ORDER_KEY: 'ncc.home.order',
  HOME_HIDDEN_KEY: 'ncc.home.hidden',
  BOOKMARKS_KEY, HISTORY_KEY, DEFAULT_ADDRESS
})

const identityFeature = createIdentity({
  byId, set, shortId, invoke, emptyState, confirm, content, applyLayout,
  getPanel: () => panel,
  getTabs: () => tabs,
  getIdentity: () => identity,
  setIdentity: (value) => { identity = value },
  getBrowserSettings: () => browserSettings,
  setBrowserSettings: (value) => { browserSettings = value },
  renderHomeIdentity: () => profileFeature.renderHomeIdentity(),
  loadProfile: () => profileFeature.loadProfile()
})

const syncFeature = createSync({
  readList, writeList, readNumber, writeNumber, invoke, set, byId, emptyState, icon,
  displayAddress, kindOf, renderBookmarks, renderHistory, renderTabGrid, applyLayout, submit,
  getTabs: () => tabs,
  getActiveTabId: () => activeTabId,
  getPanel: () => panel,
  getSwitcherKind: () => switcherKind,
  BOOKMARKS_KEY, BOOKMARKS_REMOVED_KEY, HISTORY_KEY, HISTORY_CLEARED_KEY, HISTORY_LIMIT,
  setPanel: (value) => { panel = value }
})

async function main() {
  nccSearchEnabled = readSetting('ncc.nccsearch.enabled', 'false') === 'true'
  updateNccSearchButton()
  applyTheme(readSetting('ncc.theme', 'system'))
  applyBarPosition(readSetting('ncc.bar', 'bottom'))
  applyTextSize(readSetting('ncc.text-size', 'default'))
  applyAccent(readSetting('ncc.accent', 'violet'))
  applyDensity(readSetting('ncc.density', 'comfortable'))
  applyBackButton(readSetting('ncc.back-button', 'auto'))
  applyReduceMotion(readSetting('ncc.reduce-motion', 'false'))
  renderCounts()
  renderPill()
  applyLayout()

  if (content) wireChrome()
  applyProfileNotices()

  const tauri = globalThis.__TAURI__

  if (!tauri) {
    set('bridge', 'missing (plain WebView, not the shell)')
    set('about-proxy', 'unavailable')
    return
  }

  try {
    const last = Number(readSetting('ncc.nccsearch.last-update-check', '0'))
    if (Date.now() - last >= 86_400_000) {
      writeSetting('ncc.nccsearch.last-update-check', String(Date.now()))
      void checkNccSearchUpdate(false)
    }
  } catch { /* update checks never block startup */ }

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

  // Before anything else opens a tab, so the saved ones come back in their old order.
  restoreTabs()
  openExternalLink()
  syncFeature.startSync()

  try {
    privatePort = await tauri.core.invoke('private_proxy_port')
    if (privatePort && content && typeof content.setPrivateProxyPort === 'function') {
      content.setPrivateProxyPort(privatePort)
    }
  } catch {
    // Without a private listener there are no private tabs, which is not an error.
  }

  try {
    torPort = await tauri.core.invoke('tor_proxy_port')
    if (torPort && content && typeof content.setTorProxyPort === 'function') {
      content.setTorProxyPort(torPort)
    }
  } catch {
    // Without the onion listener there are no Tor tabs; the settings page says so.
  }

  try {
    await identityFeature.setupIdentity(tauri)
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
  void profileFeature.loadProfile()

  void refreshSecurity()
}

void main()
