export function createHome(deps) {
  const {
    readList, writeList, set, byId, labelFor, avatar, submit, renderHomeIdentity,
    getNewTabMode, HOME_ORDER_KEY, HOME_HIDDEN_KEY, BOOKMARKS_KEY, HISTORY_KEY, DEFAULT_ADDRESS
  } = deps
  let homeEditMode = false

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
    return orderHomeEntries(out)
  }

  function orderHomeEntries(entries) {
    const hidden = new Set(readList(HOME_HIDDEN_KEY))
    const order = readList(HOME_ORDER_KEY)
    return entries.filter((entry) => !hidden.has(entry.address)).sort((a, b) => {
      const ai = order.indexOf(a.address)
      const bi = order.indexOf(b.address)
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
    })
  }

  /** Bookmarks lead each address family, followed by its newest visits. */
  function homeEntries(scheme) {
    const matches = (entry) => String(entry.address || '').toLowerCase().startsWith(`${scheme}://`)
    const seen = new Set()
    const out = []
    for (const entry of [...readList(BOOKMARKS_KEY), ...readList(HISTORY_KEY)]) {
      if (!matches(entry) || seen.has(entry.address)) continue
      seen.add(entry.address)
      out.push(entry)
      if (out.length >= 8) break
    }
    return orderHomeEntries(out)
  }

  function renderHome() {
    renderHomeIdentity()
    const entries = shortcutEntries()
    const suggested = readList(BOOKMARKS_KEY).length + readList(HISTORY_KEY).length === 0
    set('shortcuts-label', suggested ? 'Suggested' : 'Shortcuts')
    renderHomeTiles(byId('shortcuts'), entries)

    for (const [scheme, sectionId, listId] of [
      ['ncc', 'home-ncc-section', 'home-ncc'],
      ['nsite', 'home-nsites-section', 'home-nsites']
    ]) {
      const section = byId(sectionId)
      const categoryEntries = homeEntries(scheme)
      section.hidden = categoryEntries.length === 0
      renderHomeTiles(byId(listId), categoryEntries)
    }
  }

  function renderHomeTiles(container, entries) {
    container.textContent = ''
    for (const entry of entries) {
      const label = labelFor(entry)
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = `tile${homeEditMode ? ' editing' : ''}`
      let pressTimer = null
      let longPressed = false
      tile.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        enterHomeEditMode()
      })
      tile.addEventListener('pointerdown', () => {
        longPressed = false
        pressTimer = setTimeout(() => {
          longPressed = true
          enterHomeEditMode()
        }, 550)
      })
      const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null }
      tile.addEventListener('pointerup', cancelPress)
      tile.addEventListener('pointerleave', cancelPress)
      const name = document.createElement('span')
      name.textContent = label
      tile.append(avatar(label, '', entry.address), name)
      if (homeEditMode) {
        const remove = document.createElement('span')
        remove.className = 'tile-remove'
        remove.textContent = '×'
        remove.setAttribute('role', 'button')
        remove.setAttribute('tabindex', '0')
        remove.setAttribute('aria-label', `Remove ${label} shortcut`)
        const removeTile = (event) => {
          event.preventDefault()
          event.stopPropagation()
          writeList(HOME_HIDDEN_KEY, [...new Set([...readList(HOME_HIDDEN_KEY), entry.address])])
          renderHome()
        }
        remove.addEventListener('click', removeTile)
        remove.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') removeTile(event)
        })
        tile.appendChild(remove)
      }
      tile.addEventListener('click', () => {
        if (!longPressed && homeEditMode) {
          const order = readList(HOME_ORDER_KEY).filter((address) => address !== entry.address)
          writeList(HOME_ORDER_KEY, [entry.address, ...order])
          renderHome()
        } else if (!longPressed) {
          void submit(entry.address, { newTab: newTabMode })
        }
        longPressed = false
      })
      container.appendChild(tile)
    }
  }

  function enterHomeEditMode() {
    if (homeEditMode) return
    homeEditMode = true
    renderHome()
  }

  document.addEventListener('click', (event) => {
    if (!homeEditMode || event.target.closest?.('.tile')) return
    homeEditMode = false
    renderHome()
  })

  return { renderHome }
}
