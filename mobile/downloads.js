/*
 * Downloads screen.
 *
 * Lives in its own file because the shell's `main.js` is being rewritten elsewhere:
 * it only defines the globals that file already calls (`loadDownloads`, and
 * `__nccDownloads` for live updates from the native side).
 *
 * The list itself is owned by Kotlin — the download happens there, and the record has
 * to survive a restart — so this renders whatever `NccContent.downloads()` returns.
 */
;(function () {
  function formatBytes(bytes) {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function describe(entry) {
    const when = entry.at ? new Date(entry.at).toLocaleString() : ''

    if (entry.state === 'running') {
      const progress = formatBytes(entry.bytes)
      return progress ? `Downloading · ${progress}` : 'Downloading…'
    }
    if (entry.state === 'saved') {
      const size = formatBytes(entry.bytes)
      return size ? `Saved · ${size} · ${when}` : `Saved · ${when}`
    }
    if (entry.state === 'cancelled') return `Cancelled · ${when}`
    return `Failed · ${when}`
  }

  function render(entries) {
    const container = document.getElementById('downloads-list')
    if (!container) return

    container.textContent = ''

    const clear = document.getElementById('downloads-clear')
    const finished = (entries || []).filter((entry) => entry.state !== 'running')
    if (clear) clear.hidden = finished.length === 0

    if (!entries || entries.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = 'Nothing downloaded yet.'
      container.appendChild(empty)
      return
    }

    const card = document.createElement('div')
    card.className = 'card'

    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'list-row'

      const text = document.createElement('span')
      text.className = 'row-text'

      const name = document.createElement('b')
      name.textContent = entry.name

      const detail = document.createElement('small')
      detail.textContent = describe(entry)

      text.append(name, detail)
      row.appendChild(text)
      card.appendChild(row)
    }

    container.appendChild(card)
  }

  document.addEventListener('click', (event) => {
    const clear = event.target.closest && event.target.closest('#downloads-clear')
    if (!clear) return
    globalThis.NccContent?.clearDownloads?.()
    globalThis.loadDownloads?.()
  })

  globalThis.renderDownloads = render

  globalThis.loadDownloads = function loadDownloads() {
    let entries = []
    try {
      entries = JSON.parse(globalThis.NccContent?.downloads?.() || '[]')
    } catch {
      entries = []
    }
    render(entries)
  }

  /** Live updates pushed by the native download manager. */
  globalThis.__nccDownloads = (entries) => render(entries)
})()
