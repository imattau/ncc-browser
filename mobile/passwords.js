export function createPasswords(deps) {
  const {
    content, invoke, byId, set, displayAddress, showPanel, closePanel, goBackPanel, activeKind,
    getTabs, getActiveUrl, getActiveTabId
  } = deps
  let vaultStatus = null
  let pendingSave = null
  let editingId = null
  let deviceWaiter = null
  let fillNotice = ''
  /** Ask for the device credential: the shell cannot check it, Android can. */
  function deviceCredentialReply(ok) {
    const waiter = deviceWaiter
    deviceWaiter = null
    waiter?.(ok === true)
  }

  function reportFillFailure() {
    fillNotice = 'No login form was found on this page.'
    showPanel('password-fill')
  }

  function askDeviceCredential() {
    if (!content || typeof content.unlockWithDeviceCredential !== 'function') {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      deviceWaiter = resolve
      content.unlockWithDeviceCredential('password-vault')
      // A device with no prompt path answers immediately; this only guards a lost reply.
      setTimeout(() => {
        if (deviceWaiter === resolve) {
          deviceWaiter = null
          resolve(false)
        }
      }, 180_000)
    })
  }

  function vaultStateText(status) {
    if (!status) return 'The password vault is unavailable.'
    if (!status.configured) return 'Set up a locally stored identity to use passwords.'
    if (!status.unlocked) return 'Locked. Unlock to see saved logins.'
    const synced = status.lastSyncedAt
      ? ` · synced ${new Date(status.lastSyncedAt * 1000).toLocaleTimeString()}`
      : ''
    return `Unlocked · ${status.entryCount} saved logins${synced}${
      status.pending ? ' · relay sync pending' : ''
    }`
  }

  function vaultEmpty(text) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = text
    return empty
  }

  function vaultIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'i')
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `#i-${name}`)
    svg.appendChild(use)
    return svg
  }

  function vaultRow(entry, onOpen) {
    const row = document.createElement('div')
    row.className = 'row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0

    const icon = document.createElement('span')
    icon.className = 'row-icon'
    icon.appendChild(vaultIcon('key'))

    const text = document.createElement('span')
    text.className = 'row-text'
    const title = document.createElement('b')
    title.textContent = entry.title || entry.origin
    const detail = document.createElement('small')
    detail.textContent = entry.username ? `${entry.username} · ${entry.origin}` : entry.origin
    text.append(title, detail)

    row.append(icon, text)

    if (entry.hasTotp) {
      const totp = document.createElement('button')
      totp.className = 'ib'
      totp.type = 'button'
      totp.setAttribute('aria-label', 'Copy 2FA code')
      totp.appendChild(vaultIcon('clock'))
      totp.addEventListener('click', (event) => {
        event.stopPropagation()
        void copyTotp(entry.id)
      })
      row.appendChild(totp)
    }

    row.addEventListener('click', () => onOpen(entry))
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen(entry)
      }
    })
    return row
  }

  async function copyTotp(id) {
    try {
      const code = await invoke('vault_totp', { id })
      content.copySecret(code.code, `2FA code · ${code.remaining}s`)
    } catch (error) {
      byId('vault-note').textContent = String(error)
    }
  }

  async function loadPasswords() {
    const state = byId('vault-state')
    try {
      vaultStatus = await invoke('vault_status')
      state.textContent = vaultStateText(vaultStatus)
      if (vaultStatus.error) state.textContent = `${state.textContent} — ${vaultStatus.error}`

      byId('vault-unlock').hidden = vaultStatus.unlocked
      byId('vault-lock').hidden = !vaultStatus.unlocked
      byId('vault-lock-minutes').value = String(vaultStatus.autoLockMinutes)
      byId('vault-offer-save').checked = vaultStatus.offerSave
      byId('vault-relay').value = vaultStatus.vaultRelay || ''
      byId('vault-nip65').checked = vaultStatus.useNip65 !== false
      renderNeverSave(vaultStatus.neverSave || [])
      set(
        'sub-passwords',
        vaultStatus.unlocked ? `${vaultStatus.entryCount} saved` : 'Locked'
      )

      if (vaultStatus.unlocked) await renderVaultList()
      else byId('vault-list').textContent = ''
    } catch (error) {
      state.textContent = String(error)
    }
  }

  async function renderVaultList() {
    const list = byId('vault-list')
    list.textContent = ''
    if (!vaultStatus?.unlocked) return

    let entries = []
    try {
      entries = await invoke('vault_list')
    } catch (error) {
      list.appendChild(vaultEmpty(String(error)))
      return
    }

    const query = byId('vault-search').value.trim().toLowerCase()
    const visible = query
      ? entries.filter((entry) =>
          `${entry.title} ${entry.username} ${entry.origin}`.toLowerCase().includes(query)
        )
      : entries

    if (visible.length === 0) {
      list.appendChild(vaultEmpty(query ? 'No login matches that.' : 'No logins yet.'))
      return
    }

    for (const entry of visible) {
      list.appendChild(vaultRow(entry, (chosen) => void openPasswordEdit(chosen.id)))
    }
  }

  function renderNeverSave(origins) {
    const list = byId('vault-never')
    list.textContent = ''
    if (origins.length === 0) {
      list.appendChild(vaultEmpty('Nothing is blocked. Save prompts appear on any https or ncc page.'))
      return
    }

    for (const origin of origins) {
      const row = document.createElement('div')
      row.className = 'row'
      const text = document.createElement('span')
      text.className = 'row-text'
      const title = document.createElement('b')
      title.textContent = origin
      text.appendChild(title)

      const remove = document.createElement('button')
      remove.className = 'ib'
      remove.type = 'button'
      remove.setAttribute('aria-label', 'Allow saves again')
      remove.appendChild(vaultIcon('trash'))
      remove.addEventListener('click', async () => {
        try {
          await invoke('vault_forget_never_save', { origin })
          await loadPasswords()
        } catch (error) {
          byId('vault-note').textContent = String(error)
        }
      })

      row.append(text, remove)
      list.appendChild(row)
    }
  }

  async function unlockVault() {
    const note = byId('vault-note')
    const approved = await askDeviceCredential()
    if (!approved) {
      note.textContent = 'Unlock was cancelled.'
      return
    }
    try {
      vaultStatus = await invoke('vault_unlock')
      note.textContent = vaultStatus.error || ''
      await loadPasswords()
    } catch (error) {
      note.textContent = String(error)
    }
  }

  async function lockVault() {
    try {
      vaultStatus = await invoke('vault_lock')
      await loadPasswords()
    } catch (error) {
      byId('vault-note').textContent = String(error)
    }
  }

  async function saveVaultConfig() {
    try {
      const passwords = {
        autoLockMinutes: Math.max(
          0,
          Math.min(1440, Number(byId('vault-lock-minutes').value) || 0)
        ),
        offerSave: byId('vault-offer-save').checked,
        vaultRelay: byId('vault-relay').value.trim(),
        useNip65: byId('vault-nip65').checked,
        neverSave: vaultStatus?.neverSave || []
      }
      await invoke('vault_config', { passwords })
      byId('vault-note').textContent = 'Saved.'
      await loadPasswords()
    } catch (error) {
      byId('vault-note').textContent = String(error)
    }
  }

  async function renderPasswordFill() {
    const list = byId('fill-list')
    const note = byId('fill-note')
    list.textContent = ''
    note.textContent = fillNotice
    fillNotice = ''

    if (!getActiveUrl()) {
      note.textContent = 'Open a page first.'
      return
    }
    byId('fill-origin').textContent = displayAddress(getActiveUrl())

    // Always ask: the idle timer may have locked the vault since the last panel.
    vaultStatus = await invoke('vault_status').catch(() => vaultStatus)

    if (!vaultStatus?.unlocked) {
      const row = document.createElement('div')
      row.className = 'row'
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      const icon = document.createElement('span')
      icon.className = 'row-icon'
      icon.appendChild(vaultIcon('unlock'))
      const text = document.createElement('span')
      text.className = 'row-text'
      const title = document.createElement('b')
      title.textContent = 'Unlock passwords'
      const detail = document.createElement('small')
      detail.textContent = 'Confirm with your device lock'
      text.append(title, detail)
      row.append(icon, text)
      row.addEventListener('click', async () => {
        await unlockVault()
        await renderPasswordFill()
      })
      list.appendChild(row)
      return
    }

    let matches = []
    try {
      matches = await invoke('vault_matches', { url: getActiveUrl(), kind: activeKind() })
    } catch (error) {
      note.textContent = String(error)
      return
    }

    if (matches.length === 0) {
      list.appendChild(vaultEmpty('No saved logins for this page.'))
      return
    }

    for (const entry of matches) {
      list.appendChild(
        vaultRow(entry, async (chosen) => {
          try {
            const credentials = await invoke('vault_fill', {
              id: chosen.id,
              url: getActiveUrl(),
              kind: activeKind()
            })
            content.fillLogin(getActiveTabId(), credentials.username, credentials.password)
            closePanel()
          } catch (error) {
            note.textContent = String(error)
          }
        })
      )
    }
  }

  function openNewLogin(origin) {
    editingId = null
    byId('edit-heading').textContent = 'Add login'
    byId('edit-origin').value = origin || ''
    byId('edit-title').value = ''
    byId('edit-username').value = ''
    byId('edit-password').value = ''
    byId('edit-notes').value = ''
    byId('edit-totp').value = ''
    byId('edit-note').textContent = ''
    byId('edit-delete').hidden = true
    showPanel('password-edit')
  }

  async function openPasswordEdit(id) {
    try {
      const entry = await invoke('vault_entry', { id })
      editingId = id
      byId('edit-heading').textContent = 'Edit login'
      byId('edit-origin').value = entry.origin
      byId('edit-title').value = entry.title
      byId('edit-username').value = entry.username
      byId('edit-password').value = entry.password
      byId('edit-notes').value = entry.notes
      byId('edit-totp').value = entry.totp
      byId('edit-note').textContent = ''
      byId('edit-delete').hidden = false
      showPanel('password-edit')
    } catch (error) {
      byId('vault-note').textContent = String(error)
    }
  }

  /** Nothing to populate: the fields were set by whoever opened the panel. */
  function renderPasswordEdit() {}

  async function saveEdits() {
    const note = byId('edit-note')
    try {
      const draft = {
        id: editingId,
        origin: byId('edit-origin').value.trim(),
        title: byId('edit-title').value.trim(),
        username: byId('edit-username').value.trim(),
        password: byId('edit-password').value,
        notes: byId('edit-notes').value,
        totp: byId('edit-totp').value.trim()
      }
      const outcome = await invoke('vault_save', { draft })
      if (!outcome.ok) {
        note.textContent = outcome.error || 'Could not save that login.'
        return
      }
      pendingSave = null
      showPanel('passwords')
      byId('vault-note').textContent = outcome.pending
        ? 'Saved locally; relay sync will retry.'
        : 'Saved.'
    } catch (error) {
      note.textContent = String(error)
    }
  }

  async function deleteEditing() {
    if (!editingId) return
    try {
      const outcome = await invoke('vault_remove', { id: editingId })
      if (!outcome.ok) {
        byId('edit-note').textContent = outcome.error || 'Could not delete that login.'
        return
      }
      editingId = null
      showPanel('passwords')
      byId('vault-note').textContent = outcome.pending
        ? 'Deleted locally; relay sync will retry.'
        : 'Deleted.'
    } catch (error) {
      byId('edit-note').textContent = String(error)
    }
  }

  async function generateIntoEdit() {
    try {
      const password = await invoke('vault_generate', {
        options: { length: 20, symbols: true }
      })
      byId('edit-password').value = password
      byId('edit-note').textContent = 'Generated. Save to keep it.'
    } catch (error) {
      byId('edit-note').textContent = String(error)
    }
  }

  function renderPasswordSave() {
    if (!pendingSave) {
      goBackPanel()
      return
    }
    byId('save-origin').textContent = pendingSave.origin
    byId('save-username').textContent = pendingSave.username
      ? `Account: ${pendingSave.username}`
      : 'No username was captured.'
    byId('save-accept').textContent =
      pendingSave.mode === 'update' ? 'Update saved password' : 'Save login'
    byId('save-note').textContent = pendingSave.locked
      ? 'The vault is locked; you will be asked to unlock before saving.'
      : ''
  }

  async function respondSave(action) {
    if (!pendingSave) return
    const request = pendingSave
    try {
      if (action === 'save' && !vaultStatus?.unlocked) {
        const approved = await askDeviceCredential()
        if (!approved) return
        vaultStatus = await invoke('vault_unlock')
        if (!vaultStatus.unlocked) {
          byId('save-note').textContent = 'Unlock the vault first.'
          return
        }
      }
      const outcome = await invoke('vault_respond', { id: request.id, action })
      if (!outcome.ok && outcome.error) {
        byId('save-note').textContent = outcome.error
        return
      }
      pendingSave = null
      vaultStatus = await invoke('vault_status').catch(() => vaultStatus)
      closePanel()
    } catch (error) {
      byId('save-note').textContent = String(error)
    }
  }

  /**
   * A submitted login the native hook reported. Only a normal tab can get here: the hook
   * is not installed in private or Tor tabs.
   */
  async function handlePasswordCapture(state) {
    const tab = getTabs().find((entry) => entry.id === state.tab)
    if (!tab || tab.kind !== 'normal') return
    // The URL stamped at submit time, not the tab's current one: a login form often
    // redirects, and the credential belongs to the page that asked for it.
    const url = state.url || tab.url
    if (!url) return

    try {
      const pending = await invoke('vault_capture', {
        url,
        kind: tab.kind || 'normal',
        title: state.title || '',
        username: state.username || '',
        password: state.password || ''
      })
      if (!pending) return
      pendingSave = pending
      vaultStatus = await invoke('vault_status').catch(() => vaultStatus)
      showPanel('password-save')
    } catch {
      // An insecure page or a second prompt is not an error worth showing.
    }
  }

  return {
    deviceCredentialReply, reportFillFailure, loadPasswords, renderVaultList, unlockVault, lockVault,
    saveVaultConfig, renderPasswordFill, openNewLogin, renderPasswordSave, renderPasswordEdit,
    saveEdits, deleteEditing, generateIntoEdit, respondSave, handlePasswordCapture
  }
}
