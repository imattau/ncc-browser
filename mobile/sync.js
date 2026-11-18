const SYNC_KEY = 'ncc.sync'
const SYNC_DEVICES_KEY = 'ncc.sync.devices'
const SYNC_DEBOUNCE_MS = 15000
const SYNC_FOCUS_MS = 30000
const SYNC_POLL_MS = 5 * 60 * 1000

export function createSync(deps) {
  const {
    readList, writeList, readNumber, writeNumber, invoke, set, byId, emptyState, icon,
    displayAddress, kindOf, renderBookmarks, renderHistory, renderTabGrid, applyLayout, submit,
    getTabs, getActiveTabId, getPanel, getSwitcherKind, setPanel,
    BOOKMARKS_KEY, BOOKMARKS_REMOVED_KEY, HISTORY_KEY, HISTORY_CLEARED_KEY, HISTORY_LIMIT
  } = deps


  /** Bumped on every local bookmark or history change, so a stale result is not applied. */
  let syncRev = 0
  let syncRunning = false
  let syncAgain = false
  let syncTimer = null
  let syncStarted = false
  let syncState = { at: 0, error: '' }

  function isSyncable(address) {
    const value = String(address || '').trim()
    return value.length > 0 && value.length <= 4096 && /^(ncc:\/\/|https?:\/\/)/i.test(value)
  }

  function randomId() {
    const bytes = new Uint8Array(8)
    globalThis.crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  /** What to sync and which device this is. Everything is off until it is switched on. */
  function syncPrefs() {
    let saved = {}
    try {
      saved = JSON.parse(globalThis.localStorage?.getItem(SYNC_KEY) || '{}') || {}
    } catch {
      saved = {}
    }
    const prefs = {
      bookmarks: saved.bookmarks === true,
      tabs: saved.tabs === true,
      history: saved.history === true,
      deviceId: /^[0-9a-f]{16}$/.test(saved.deviceId || '') ? saved.deviceId : randomId(),
      deviceName:
        typeof saved.deviceName === 'string' && saved.deviceName.trim()
          ? saved.deviceName.trim().slice(0, 80)
          : 'Android phone'
    }
    if (saved.deviceId !== prefs.deviceId) saveSyncPrefs(prefs)
    return prefs
  }

  function saveSyncPrefs(prefs) {
    try {
      globalThis.localStorage?.setItem(SYNC_KEY, JSON.stringify(prefs))
    } catch {
      // Storage unavailable: sync stays off.
    }
  }

  function syncEnabled(prefs = syncPrefs()) {
    return prefs.bookmarks || prefs.tabs || prefs.history
  }

  function syncDevices() {
    return readList(SYNC_DEVICES_KEY)
  }

  function bookmarkDoc() {
    const entries = readList(BOOKMARKS_KEY)
      .filter((entry) => isSyncable(entry.address))
      .map((entry) => ({
        url: entry.address,
        title: entry.title || entry.address,
        createdAt: entry.at || 0,
        updatedAt: entry.updatedAt || entry.at || 0
      }))
    for (const entry of readList(BOOKMARKS_REMOVED_KEY)) {
      if (!isSyncable(entry.address)) continue
      entries.push({
        url: entry.address,
        title: entry.address,
        createdAt: entry.createdAt || 0,
        updatedAt: entry.deletedAt || 0,
        deleted: true
      })
    }
    return { v: 1, updatedAt: 0, entries }
  }

  function applyBookmarkDoc(doc) {
    const live = doc.entries
      .filter((entry) => !entry.deleted)
      .map((entry) => ({
        address: entry.url,
        title: entry.title,
        at: entry.createdAt,
        updatedAt: entry.updatedAt
      }))
    // Anything the sync format cannot carry (an nsite:// address) stays as it was.
    const kept = readList(BOOKMARKS_KEY).filter((entry) => !isSyncable(entry.address))
    writeList(BOOKMARKS_KEY, [...live, ...kept])
    writeList(
      BOOKMARKS_REMOVED_KEY,
      doc.entries
        .filter((entry) => entry.deleted)
        .map((entry) => ({
          address: entry.url,
          createdAt: entry.createdAt,
          deletedAt: entry.updatedAt
        }))
    )
  }

  function historyInput() {
    return {
      clearedBefore: readNumber(HISTORY_CLEARED_KEY),
      entries: readList(HISTORY_KEY)
        .filter((entry) => isSyncable(entry.address))
        .map((entry) => ({
          url: entry.address,
          title: entry.title || entry.address,
          visits: entry.visits || 1,
          lastVisit: entry.at || 0
        }))
    }
  }

  function applyHistory(output) {
    writeNumber(HISTORY_CLEARED_KEY, output.clearedBefore)
    const merged = output.entries.map((entry) => ({
      address: entry.url,
      title: entry.title,
      at: entry.lastVisit,
      visits: entry.visits
    }))
    const kept = readList(HISTORY_KEY).filter((entry) => !isSyncable(entry.address))
    const all = [...merged, ...kept].sort((a, b) => (b.at || 0) - (a.at || 0))
    writeList(HISTORY_KEY, all.slice(0, HISTORY_LIMIT))
  }

  /** Normal tabs only: a private or Tor tab is never listed, not even its address. */
  function syncTabs() {
    return getTabs()
      .filter((tab) => kindOf(tab) === 'normal' && tab.url)
      .map((tab) => ({
        url: displayAddress(tab.url),
        title: String(tab.title || '').slice(0, 300),
        lastActive: tab.id === getActiveTabId() ? Date.now() : 0
      }))
      .filter((tab) => isSyncable(tab.url))
      .slice(0, 60)
  }

  async function syncNow() {
    const prefs = syncPrefs()
    if (!syncEnabled(prefs)) {
      renderSync()
      return
    }
    if (syncRunning) {
      syncAgain = true
      return
    }
    syncRunning = true
    syncState = { ...syncState, error: '' }
    renderSync()
    const rev = syncRev
    try {
      const response = await invoke('sync_exchange', {
        request: {
          device: { id: prefs.deviceId, name: prefs.deviceName, platform: 'android' },
          now: Date.now(),
          bookmarks: prefs.bookmarks ? bookmarkDoc() : null,
          history: prefs.history ? historyInput() : null,
          tabs: prefs.tabs ? syncTabs() : null
        }
      })
      if (rev === syncRev) {
        if (response.bookmarks) applyBookmarkDoc(response.bookmarks)
        if (response.history) applyHistory(response.history)
      } else {
        // Something changed while the relays were being asked; sync again with it.
        syncAgain = true
      }
      writeList(SYNC_DEVICES_KEY, prefs.tabs ? response.devices || [] : [])
      syncState = {
        at: Date.now(),
        error: (response.errors || []).join('; ')
      }
    } catch (error) {
      syncState = { ...syncState, error: String(error) }
    } finally {
      syncRunning = false
    }
    renderSync()
    renderBookmarks()
    if (getPanel() === 'history') renderHistory()
    if (getPanel() === 'switcher') renderTabGrid()
    if (syncAgain) {
      // Something changed meanwhile, or another sync was asked for: go again now.
      syncAgain = false
      void syncNow()
    }
  }

  function renderSync() {
    const prefs = syncPrefs()
    const on = syncEnabled(prefs)
    set(
      'sub-sync',
      on
        ? ['bookmarks', 'tabs', 'history'].filter((key) => prefs[key]).join(', ')
        : 'Bookmarks, tabs and history'
    )
    if (getPanel() !== 'sync') return

    for (const key of ['bookmarks', 'tabs', 'history']) byId(`sync-${key}`).checked = prefs[key]
    byId('sync-now').disabled = !on || syncRunning
    byId('sync-state').textContent = syncRunning
      ? 'Syncing…'
      : syncState.error
        ? `${syncState.error} Your data is still saved on this phone; sync will try again.`
        : syncState.at
          ? `Last synced ${new Date(syncState.at).toLocaleTimeString()}`
          : on
            ? 'Waiting for the first sync'
            : 'Off'
    const name = byId('sync-device-name')
    if (document.activeElement !== name) name.value = prefs.deviceName

    const list = byId('sync-devices')
    list.textContent = ''
    const devices = syncDevices()
    if (devices.length === 0) {
      emptyState(
        list,
        prefs.tabs
          ? 'None yet. Turn on open tabs on your other devices, then sync.'
          : 'Turn on open tabs to see tabs from your other devices.'
      )
      return
    }
    for (const device of devices) {
      const row = document.createElement('div')
      row.className = 'list-row'
      const text = document.createElement('div')
      text.className = 'row-text'
      const title = document.createElement('b')
      title.textContent = device.name
      const detail = document.createElement('small')
      detail.textContent = `${device.tabs.length} ${device.tabs.length === 1 ? 'tab' : 'tabs'} · ${new Date(device.updatedAt).toLocaleString()}`
      text.append(title, detail)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'ib'
      remove.setAttribute('aria-label', `Remove ${device.name}`)
      remove.appendChild(icon('trash'))
      remove.addEventListener('click', async () => {
        try {
          await invoke('sync_remove_device', {
            device: { id: device.id, name: device.name, platform: device.platform },
            now: Date.now()
          })
          writeList(
            SYNC_DEVICES_KEY,
            syncDevices().filter((entry) => entry.id !== device.id)
          )
        } catch (error) {
          syncState = { ...syncState, error: String(error) }
        }
        renderSync()
      })
      row.append(icon(device.platform === 'android' ? 'phone' : 'monitor'), text, remove)
      list.appendChild(row)
    }
  }

  /** Tabs open on the other devices, listed at the end of the normal tab grid. */
  function renderDeviceTabs(grid) {
    const devices = syncDevices().filter((device) => device.tabs.length > 0)
    if (getSwitcherKind() !== 'normal' || devices.length === 0) return
    for (const device of devices) {
      const head = document.createElement('p')
      head.className = 'section-label'
      head.style.gridColumn = '1 / -1'
      head.textContent = device.name
      grid.appendChild(head)

      const card = document.createElement('div')
      card.className = 'card'
      card.style.gridColumn = '1 / -1'
      for (const tab of device.tabs.slice(0, 12)) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'row'
        const text = document.createElement('span')
        text.className = 'row-text'
        const title = document.createElement('b')
        title.textContent = tab.title || tab.url
        const detail = document.createElement('small')
        detail.textContent = tab.url
        text.append(title, detail)
        button.append(icon(device.platform === 'android' ? 'phone' : 'monitor'), text)
        button.addEventListener('click', () => {
          setPanel('home')
          applyLayout()
          void submit(tab.url, { newTab: true })
        })
        card.appendChild(button)
      }
      grid.appendChild(card)
    }
  }

  function startSync() {
    if (syncStarted) return
    syncStarted = true
    renderSync()

    for (const key of ['bookmarks', 'tabs', 'history']) {
      byId(`sync-${key}`).addEventListener('change', (event) => {
        const prefs = syncPrefs()
        prefs[key] = event.target.checked
        saveSyncPrefs(prefs)
        syncRev += 1
        void syncNow()
      })
    }
    byId('sync-now').addEventListener('click', () => void syncNow())
    const rename = () => {
      const value = byId('sync-device-name').value.trim()
      const prefs = syncPrefs()
      if (!value || value === prefs.deviceName) return
      prefs.deviceName = value.slice(0, 80)
      saveSyncPrefs(prefs)
      void syncNow()
    }
    byId('sync-device-name').addEventListener('change', rename)

    let lastFocusSync = 0
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastFocusSync < SYNC_FOCUS_MS) return
      lastFocusSync = Date.now()
      void syncNow()
    })
    setInterval(() => {
      if (document.visibilityState === 'visible') void syncNow()
    }, SYNC_POLL_MS)
    setTimeout(() => void syncNow(), 5000)
  }

  function localChanged(category) {
    if (category !== 'tabs') syncRev += 1
    if (!syncStarted) return
    const prefs = syncPrefs()
    if (!prefs[category]) return
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      void syncNow()
    }, SYNC_DEBOUNCE_MS)
  }

  return { localChanged, renderSync, renderDeviceTabs, startSync }
}
