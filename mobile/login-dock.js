/**
 * The login sheet: it slides up beside the address bar while the page stays usable.
 * It offers saved logins when a login field has focus, and offers to save one that was
 * just sent. A page only ever reports; every fill and save is a tap here.
 */

/** The native vault forgets a captured password after this long without an answer. */
const SAVE_TTL = 120_000
const MAX_CHOICES = 3

export function createLoginDock(deps) {
  const {
    content, invoke, byId, displayAddress, showPanel, relayout, activeKind, vault,
    getTabs, getActiveTabId
  } = deps

  /** The login waiting for an answer, and how far saving it has got. */
  let offer = null
  /** Saved logins for the focused field: `{ tab, url, locked, matches, busy }`. */
  let fill = null
  /** A short message left behind by a fill that needs a word. */
  let notice = null
  /** Origins whose fill sheet was closed; a new page load asks again. */
  const closed = new Map()
  let focusRequest = 0
  let offerTimer = null
  let noticeTimer = null
  let docked = 0

  const current = () => (offer ? 'save' : notice ? 'notice' : fill ? 'fill' : null)

  function setNotice(text, tone, ms = 4_000) {
    clearTimeout(noticeTimer)
    notice = { text, tone }
    noticeTimer = setTimeout(() => {
      notice = null
      relayout()
    }, ms)
    relayout()
  }

  function clearOffer() {
    clearTimeout(offerTimer)
    offer = null
    relayout()
  }

  function expireLater(ms) {
    clearTimeout(offerTimer)
    offerTimer = setTimeout(() => {
      if (offer?.state !== 'saving') clearOffer()
    }, ms)
  }

  /* ───────────── Drawing ───────────── */

  function result(text, tone) {
    const note = byId('dock-note')
    note.textContent = ''
    note.className = text ? 'status result' : 'status'
    note.dataset.tone = tone || ''
    if (!text) return
    const mark = document.createElement(tone === 'busy' ? 'span' : 'b')
    if (tone === 'busy') mark.className = 'spinner'
    else mark.textContent = tone === 'ok' ? '✓' : '!'
    mark.setAttribute('aria-hidden', 'true')
    const words = document.createElement('span')
    words.textContent = text
    note.append(mark, words)
  }

  function choice(title, detail, onClick, disabled) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'row'
    row.disabled = disabled
    const text = document.createElement('span')
    text.className = 'row-text'
    const heading = document.createElement('b')
    heading.textContent = title
    const small = document.createElement('small')
    small.textContent = detail
    text.append(heading, small)
    row.append(text)
    row.addEventListener('click', onClick)
    return row
  }

  function drawSave() {
    const { request, state, message, tone } = offer
    const update = request.mode === 'update'
    byId('dock-title').textContent = state === 'done' ? 'Passwords' : update ? 'Update saved password?' : 'Save this login?'
    byId('dock-detail').textContent = `${request.username || 'No username'} · ${displayAddress(request.origin)}`
    byId('dock-list').textContent = ''
    byId('dock-actions').hidden = state === 'done'
    const accept = byId('save-accept')
    const saving = state === 'saving'
    accept.textContent = saving ? 'Saving…' : state === 'failed' ? 'Try again' : update ? 'Update password' : 'Save login'
    accept.setAttribute('aria-busy', String(saving))
    for (const id of ['save-accept', 'save-never', 'save-dismiss']) byId(id).disabled = saving
    byId('dock-close').hidden = saving
    if (state === 'saving') result('This can take a few seconds while relays respond.', 'busy')
    else if (message) result(message, tone)
    else result(request.locked ? 'You will be asked to unlock your passwords.' : '', '')
  }

  function drawFill() {
    byId('dock-title').textContent = 'Fill a saved login'
    byId('dock-detail').textContent = displayAddress(fill.url)
    byId('dock-actions').hidden = true
    byId('dock-close').hidden = false
    result(fill.error || '', fill.error ? 'error' : '')
    const list = byId('dock-list')
    list.textContent = ''
    if (fill.locked) {
      list.append(choice('Unlock passwords', 'Confirm with your device lock', () => void unlockForFill(), fill.busy))
      return
    }
    for (const entry of fill.matches.slice(0, MAX_CHOICES)) {
      list.append(choice(entry.username || entry.title || 'Saved login', entry.title || 'Tap to fill', () => void fillWith(entry), fill.busy))
    }
    if (fill.matches.length > MAX_CHOICES) {
      list.append(choice(`All ${fill.matches.length} logins`, 'Choose another account', () => showPanel('password-fill'), false))
    }
  }

  function drawNotice() {
    byId('dock-title').textContent = 'Passwords'
    byId('dock-detail').textContent = ''
    byId('dock-list').textContent = ''
    byId('dock-actions').hidden = true
    byId('dock-close').hidden = false
    result(notice.text, notice.tone)
  }

  /**
   * Draw the sheet and give it room below the page. `allowed` is false whenever the
   * shell is showing something of its own. Returns whether the sheet is up.
   */
  function sync(allowed) {
    const view = allowed ? current() : null
    const root = byId('login-dock')
    root.hidden = !view
    if (!view) {
      if (docked) {
        docked = 0
        content?.dock?.(0)
      }
      return false
    }
    if (view === 'save') drawSave()
    else if (view === 'fill') drawFill()
    else drawNotice()
    // The body keeps its natural height however small the shell currently is.
    const height = Math.ceil(byId('login-dock-body').offsetHeight) + 1
    if (height !== docked) {
      docked = height
      content?.dock?.(height)
    }
    return true
  }

  /* ───────────── Offering to save ───────────── */

  function offerSave(request) {
    // A newer sign-in replaces an unanswered one, but not a save already running.
    if (offer?.state === 'saving') {
      offer.next = request
      return
    }
    offer = { request, state: 'ask', message: '', tone: '', next: null }
    expireLater(SAVE_TTL)
    relayout()
  }

  /** "Not now" and "Never" write nothing to the vault, so the sheet just leaves. */
  async function decline(active, action) {
    clearOffer()
    try {
      const outcome = await invoke('vault_respond', { id: active.request.id, action })
      if (!outcome.ok && action === 'never') setNotice(outcome.error || 'Could not remember that choice.', 'error')
      else await vault.changed()
    } catch (error) {
      if (action === 'never') setNotice(String(error), 'error')
    }
  }

  async function respond(action) {
    const active = offer
    if (!active || active.state === 'saving' || active.state === 'done') return
    if (action !== 'save') {
      await decline(active, action)
      return
    }
    const fail = (message) => {
      Object.assign(active, { state: 'failed', message, tone: 'error' })
      expireLater(SAVE_TTL)
      relayout()
    }
    active.state = 'saving'
    relayout()
    try {
      const unlocked = await vault.ensureUnlocked()
      if (!unlocked.ok) {
        fail(unlocked.error)
        return
      }
      const outcome = await invoke('vault_respond', { id: active.request.id, action })
      if (!outcome.ok) {
        fail(outcome.error || 'Could not save that login.')
        return
      }
      await vault.changed()
      if (active.next) {
        offer = null
        offerSave(active.next)
        return
      }
      Object.assign(active, {
        state: 'done',
        message: outcome.pending
          ? 'Saved on this device. Relay sync will retry.'
          : active.request.mode === 'update' ? 'Password updated.' : 'Login saved.',
        tone: outcome.pending ? 'warn' : 'ok'
      })
      expireLater(outcome.pending ? 5_000 : 2_500)
      relayout()
    } catch (error) {
      fail(String(error))
    }
  }

  /** A login the page sent. Only a normal tab can get here. */
  async function handleCapture(state) {
    const tab = getTabs().find((entry) => entry.id === state.tab)
    if (!tab || tab.kind !== 'normal' || !state.url) return
    try {
      const request = await invoke('vault_capture', {
        url: state.url,
        kind: tab.kind,
        title: state.title || '',
        username: state.username || '',
        password: state.password || ''
      })
      if (!request) return
      fill = null
      offerSave(request)
    } catch {
      // An insecure page is not an error worth showing.
    }
  }

  async function handleUsername(state) {
    const tab = getTabs().find((entry) => entry.id === state.tab)
    if (!tab || tab.kind !== 'normal' || !state.url) return
    await invoke('vault_username', { url: state.url, kind: tab.kind, username: state.username || '' }).catch(() => {})
  }

  /* ───────────── Offering to fill ───────────── */

  async function lookUp(tab, url) {
    const request = ++focusRequest
    const status = await vault.status()
    if (request !== focusRequest) return
    let next = null
    if (status?.unlocked) {
      const matches = await invoke('vault_matches', { url, kind: activeKind() }).catch(() => [])
      if (request !== focusRequest) return
      const logins = matches.filter((entry) => !entry.isPasskey)
      if (logins.length) next = { tab, url, locked: false, matches: logins, busy: false, error: '' }
    } else if (status?.configured) {
      next = { tab, url, locked: true, matches: [], busy: false, error: '' }
    }
    fill = next
    relayout()
  }

  async function handleFocus(state) {
    if (state.tab !== getActiveTabId()) return
    const kind = activeKind()
    if (!state.login || kind !== 'normal' || closed.get(state.tab) === state.url) {
      focusRequest += 1
      if (fill) {
        fill = null
        relayout()
      }
      return
    }
    await lookUp(state.tab, state.url)
  }

  async function unlockForFill() {
    const active = fill
    if (!active || active.busy) return
    active.busy = true
    relayout()
    const unlocked = await vault.ensureUnlocked()
    if (fill !== active) return
    if (!unlocked.ok) {
      Object.assign(active, { busy: false, error: unlocked.error })
      relayout()
      return
    }
    await lookUp(active.tab, active.url)
    if (!fill) setNotice('No saved logins for this page.', 'warn')
  }

  async function fillWith(entry) {
    const active = fill
    if (!active || active.busy) return
    active.busy = true
    relayout()
    try {
      const credentials = await invoke('vault_fill', { id: entry.id, url: active.url, kind: activeKind() })
      if (fill !== active || active.tab !== getActiveTabId()) return
      // The page URL goes along: native code fills only if the tab is still on it.
      content.fillLogin(active.tab, credentials.username, credentials.password, active.url)
      fill = null
      relayout()
    } catch (error) {
      if (fill !== active) return
      Object.assign(active, { busy: false, error: String(error) })
      relayout()
    }
  }

  /** What the page script made of a fill. */
  function filled(outcome) {
    if (outcome === 'filled') return
    if (outcome === 'username') setNotice('Username filled. Continue, then fill the password.', 'ok', 5_000)
    else if (outcome === 'moved') setNotice('The page changed, so nothing was filled.', 'warn')
    else setNotice('No login fields were found on this page.', 'warn')
  }

  /* ───────────── Page and tab changes ───────────── */

  /** The fields are gone. A save offer stays: signing in is what loads a new page. */
  function pageLoading(tab) {
    closed.delete(tab)
    if (fill?.tab !== tab) return
    focusRequest += 1
    fill = null
    relayout()
  }

  function tabChanged(tab) {
    if (!fill || fill.tab === tab) return
    focusRequest += 1
    fill = null
  }

  function close() {
    const view = current()
    if (view === 'save') void respond('dismiss')
    else if (view === 'notice') {
      clearTimeout(noticeTimer)
      notice = null
      relayout()
    } else if (fill) {
      closed.set(fill.tab, fill.url)
      fill = null
      relayout()
    }
  }

  return {
    sync, respond, close, handleCapture, handleUsername, handleFocus, filled, pageLoading, tabChanged,
    height: () => docked
  }
}
