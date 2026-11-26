import { makeVaultAssertion, makeVaultPasskey, validateRpId } from './passkeys.js'

export function createPasswords(deps) {
  const {
    content, invoke, byId, set, displayAddress, showPanel, closePanel, goBackPanel, activeKind,
    getTabs, getActiveUrl, getActiveTabId
  } = deps
  let vaultStatus = null
  let pendingSave = null
  let editingId = null
  let revealedPassword = null
  let revealTimer = null
  let revealRequest = 0
  let editPasswordRevealed = false
  let deviceWaiter = null
  let fillNotice = ''
  let deletingId = null
  let toastTimer = null
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

  function askDeviceCredential(purpose = 'password-vault') {
    if (!content || typeof content.unlockWithDeviceCredential !== 'function') {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      deviceWaiter = resolve
      content.unlockWithDeviceCredential(purpose)
      // A device with no prompt path answers immediately; this only guards a lost reply.
      setTimeout(() => {
        if (deviceWaiter === resolve) {
          deviceWaiter = null
          resolve(false)
        }
      }, 180_000)
    })
  }

  async function approvePasskey(purpose, message) {
    if (typeof content?.unlockWithDeviceCredential === 'function') {
      if (typeof content.passkeyConfirmationFallback === 'function' && content.passkeyConfirmationFallback()) {
        return window.confirm(message)
      }
      return askDeviceCredential(purpose)
    }
    return window.confirm(message)
  }

  function nativePasskeyApprovalAvailable() {
    return typeof content?.unlockWithDeviceCredential === 'function' &&
      !(typeof content.passkeyConfirmationFallback === 'function' && content.passkeyConfirmationFallback())
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

  function vaultRow(entry, onOpen, { allowReveal = false } = {}) {
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
    detail.textContent = `${entry.isPasskey ? 'Passkey · ' : ''}${entry.username ? `${entry.username} · ` : ''}${entry.origin}`
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

    const favorite = document.createElement('button')
    favorite.className = 'ib'
    favorite.type = 'button'
    favorite.setAttribute('aria-label', entry.favorite ? 'Remove favorite' : 'Add favorite')
    favorite.textContent = entry.favorite ? '★' : '☆'
    favorite.addEventListener('click', async (event) => {
      event.stopPropagation()
      try {
        await invoke('vault_favorite', { id: entry.id, favorite: !entry.favorite })
        await renderVaultList()
      } catch (error) { byId('vault-note').textContent = String(error) }
    })
    row.appendChild(favorite)

    if (allowReveal && !entry.isPasskey) {
      const reveal = document.createElement('button')
      reveal.className = 'ib'
      reveal.type = 'button'
      const isRevealed = revealedPassword?.id === entry.id
      reveal.setAttribute('aria-label', isRevealed ? 'Hide password' : 'Reveal password')
      reveal.setAttribute('aria-pressed', String(isRevealed))
      reveal.appendChild(vaultIcon(isRevealed ? 'eye-off' : 'eye'))
      reveal.addEventListener('click', (event) => {
        event.stopPropagation()
        void togglePasswordReveal(entry.id)
      })
      row.appendChild(reveal)
    }

    row.addEventListener('click', () => onOpen(entry))
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen(entry)
      }
    })
    if (!allowReveal) return row

    const wrapper = document.createElement('div')
    wrapper.className = 'vault-entry'
    wrapper.appendChild(row)
    if (revealedPassword?.id === entry.id) {
      const password = document.createElement('code')
      password.className = 'vault-entry-password'
      password.textContent = revealedPassword.password
      wrapper.appendChild(password)
    }
    return wrapper
  }

  function clearPasswordReveal(render = false) {
    revealRequest += 1
    if (revealTimer !== null) clearTimeout(revealTimer)
    revealTimer = null
    revealedPassword = null
    const list = byId('vault-list')
    list.querySelectorAll('.vault-entry-password').forEach((node) => node.remove())
    list.querySelectorAll('button[aria-label="Hide password"]').forEach((button) => {
      button.setAttribute('aria-label', 'Reveal password')
      button.setAttribute('aria-pressed', 'false')
      button.querySelector('use')?.setAttribute('href', '#i-eye')
    })
    if (render && vaultStatus?.unlocked) void renderVaultList()
  }

  async function togglePasswordReveal(id) {
    if (revealedPassword?.id === id) {
      clearPasswordReveal(true)
      return
    }

    clearPasswordReveal(false)
    const request = ++revealRequest
    try {
      const entry = await invoke('vault_entry', { id })
      if (request !== revealRequest || !vaultStatus?.unlocked) return
      revealedPassword = { id, password: entry.password || '' }
      await renderVaultList()
      if (request !== revealRequest || revealedPassword?.id !== id) return
      revealTimer = setTimeout(() => {
        if (revealedPassword?.id !== id) return
        clearPasswordReveal(true)
      }, 15_000)
    } catch (error) {
      if (request === revealRequest) byId('vault-note').textContent = String(error)
    }
  }

  function setEditPasswordRevealed(revealed) {
    editPasswordRevealed = revealed
    const input = byId('edit-password')
    const button = byId('edit-password-toggle')
    input.type = revealed ? 'text' : 'password'
    button.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password')
    button.setAttribute('aria-pressed', String(revealed))
    button.querySelector('use').setAttribute('href', revealed ? '#i-eye-off' : '#i-eye')
  }

  function onPanelChange(from, to) {
    if (from === 'passwords' && to !== 'passwords') clearPasswordReveal(false)
    if (from === 'password-edit' && to !== 'password-edit') setEditPasswordRevealed(false)
  }

  function onAppBackground() {
    clearPasswordReveal(false)
    setEditPasswordRevealed(false)
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
      else {
        clearPasswordReveal(false)
        setEditPasswordRevealed(false)
        byId('vault-list').textContent = ''
      }
    } catch (error) {
      state.textContent = String(error)
    }
  }

  /**
   * The native side caught the vault up in the background. Only the list and the status
   * line are redrawn, so settings someone is typing are left alone.
   */
  async function vaultSynced() {
    try {
      vaultStatus = await invoke('vault_status')
      if (!vaultStatus.unlocked) return
      const state = vaultStateText(vaultStatus)
      byId('vault-state').textContent = vaultStatus.error ? `${state} — ${vaultStatus.error}` : state
      set('sub-passwords', `${vaultStatus.entryCount} saved`)
      await renderVaultList()
    } catch (error) {
      byId('vault-note').textContent = String(error)
    }
  }

  async function renderVaultList() {
    const list = byId('vault-list')
    if (!vaultStatus?.unlocked) {
      list.textContent = ''
      return
    }

    let entries = []
    try {
      entries = await invoke('vault_list')
    } catch (error) {
      list.textContent = ''
      list.appendChild(vaultEmpty(String(error)))
      return
    }
    // Cleared only now, so two renders in flight cannot both append their rows.
    list.textContent = ''

    const query = byId('vault-search').value.trim().toLowerCase()
    const filter = byId('vault-filter')?.value || 'all'
    const sort = byId('vault-sort')?.value || 'newest'
    const visible = entries.filter((entry) => (filter !== 'favorites' || entry.favorite) && (!query || `${entry.title} ${entry.username} ${entry.origin}`.toLowerCase().includes(query)))
    visible.sort((a, b) => sort === 'title' ? (a.title || a.origin).localeCompare(b.title || b.origin) : sort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt)

    if (visible.length === 0) {
      list.appendChild(vaultEmpty(query ? 'No login matches that.' : 'No logins yet.'))
      return
    }

    for (const entry of visible) {
      list.appendChild(vaultRow(entry, (chosen) => {
        if (chosen.isPasskey) {
          byId('vault-note').textContent = 'This passkey is ready for sign-in on its website.'
          return
        }
        void openPasswordEdit(chosen.id)
      }, { allowReveal: true }))
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
    clearPasswordReveal(false)
    setEditPasswordRevealed(false)
    try {
      vaultStatus = await invoke('vault_lock')
      await loadPasswords()
    } catch (error) {
      byId('vault-note').textContent = String(error)
    }
  }

  async function passkeyCandidates(origin, options) {
    let rpId
    try { rpId = validateRpId(origin, options.rpId) } catch { return [] }
    const allowed = new Set((options.allowCredentials || []).map((item) => item.id).filter(Boolean))
    const summaries = await invoke('vault_list')
    const output = []
    for (const summary of summaries) {
      if (!summary.isPasskey) continue
      const entry = await invoke('vault_entry', { id: summary.id })
      const passkey = entry?.passkey
      if (!passkey || passkey.rpId !== rpId || (allowed.size && !allowed.has(passkey.credentialId))) continue
      if (!allowed.size && !passkey.discoverable) continue
      output.push({ entryId: summary.id, credentialId: passkey.credentialId, name: passkey.userName || passkey.userDisplayName || 'Passkey' })
    }
    return output
  }

  async function handleWebauthnRequest(request) {
    const reply = (value) => content?.resolvePasskey?.(request.tab, request.requestId, JSON.stringify(value))
    const fallback = () => reply({ handled: false })
    const failed = (error) => reply({
      handled: true,
      error: error?.message || 'The passkey request failed',
      errorName: error?.name || 'NotAllowedError'
    })
    try {
      const tab = getTabs().find((entry) => entry.id === request.tab)
      if (!tab || tab.kind !== 'normal' || !request.origin || new URL(tab.url).origin !== request.origin) return fallback()
      if (request.operation === 'candidates') {
        const status = await invoke('vault_status')
        if (!status.unlocked) return reply({ handled: true, candidates: [] })
        return reply({ handled: true, candidates: await passkeyCandidates(request.origin, request.options || {}) })
      }
      if (request.operation !== 'create' && request.operation !== 'get') return fallback()

      let status = await invoke('vault_status')
      if (!status.configured) return fallback()
      let passkeyApprovedNatively = false
      if (!status.unlocked) {
        const host = new URL(request.origin).host
        const purpose = request.operation === 'create'
          ? `passkey-create|${host}`
          : `passkey-use|${host}`
        const approved = await askDeviceCredential(purpose)
        if (!approved) return fallback()
        passkeyApprovedNatively = nativePasskeyApprovalAvailable()
        status = await invoke('vault_unlock')
        vaultStatus = status
      }
      if (!status.unlocked) return fallback()

      const options = request.credentialId
        ? { ...(request.options || {}), allowCredentials: [{ id: request.credentialId }] }
        : request.options || {}
      if (request.operation === 'create') {
        let rpId
        try { rpId = validateRpId(request.origin, options.rp?.id) } catch { return reply({ handled: false }) }
        const exclude = new Set((options.excludeCredentials || []).map((item) => item.id).filter(Boolean))
        const existing = exclude.size
          ? await passkeyCandidates(request.origin, { rpId, allowCredentials: Array.from(exclude, (id) => ({ id })) })
          : []
        if (existing.length) return reply({ handled: true, error: 'InvalidStateError' })
        const username = String(options.user?.name || 'Passkey').slice(0, 320)
        const host = new URL(request.origin).host
        if (!passkeyApprovedNatively && !await approvePasskey(`passkey-create|${host}`, `Create a passkey for ${username} at ${host}? It will be stored in your encrypted NCC password vault and synced with that vault.`)) {
          return reply({ handled: true, error: 'NotAllowedError' })
        }
        const made = await makeVaultPasskey(options, request.origin)
        await invoke('vault_passkey_save', {
          origin: request.origin,
          username: made.record.userName,
          passkey: made.record
        })
        return reply({ handled: true, response: made.response })
      }

      const candidates = await passkeyCandidates(request.origin, options)
      if (!candidates.length) return fallback()
      // NCC confirms every use. When several credentials match, let the user choose
      // one explicitly rather than exposing the private vault index to page content.
      let chosen = candidates[0]
      if (candidates.length > 1) {
        const labels = candidates.map((item, index) => `${index + 1}. ${item.name}`).join('\n')
        const answer = window.prompt(`Choose a passkey for ${new URL(request.origin).host}:\n${labels}`, '1')
        const index = Number(answer) - 1
        if (!Number.isInteger(index) || index < 0 || index >= candidates.length) return reply({ handled: true, error: 'NotAllowedError' })
        chosen = candidates[index]
      }
      const host = new URL(request.origin).host
      if (!passkeyApprovedNatively && !await approvePasskey(`passkey-use|${host}|${chosen.name}`, `Use the NCC passkey for ${chosen.name} on ${host}?`)) {
        return reply({ handled: true, error: 'NotAllowedError' })
      }
      const entry = await invoke('vault_entry', { id: chosen.entryId })
      const record = entry?.passkey
      if (!record || record.credentialId !== chosen.credentialId) return reply({ handled: true, error: 'NotAllowedError' })
      return reply({ handled: true, response: await makeVaultAssertion(record, options.challenge, request.origin, options.userVerification) })
    } catch (error) {
      return failed(error)
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
    setEditPasswordRevealed(false)
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
    showDeleteProgress()
    showPanel('password-edit')
  }

  async function openPasswordEdit(id) {
    try {
      const entry = await invoke('vault_entry', { id })
      setEditPasswordRevealed(false)
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
      showDeleteProgress()
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

  /** An icon and a message, so success and failure are told apart at a glance. */
  function showResult(element, tone, message) {
    const result = document.createElement('span')
    result.className = 'result'
    result.dataset.tone = tone
    const text = document.createElement('span')
    text.textContent = message
    result.append(vaultIcon(tone === 'ok' ? 'check' : 'warn'), text)
    element.textContent = ''
    element.appendChild(result)
  }

  function hideVaultToast() {
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = null
    byId('vault-toast').hidden = true
  }

  /** Shown above the list's scrolling area: a note under a long list is never seen. */
  function showVaultToast(tone, message) {
    hideVaultToast()
    const toast = byId('vault-toast')
    showResult(toast, tone, message)
    toast.hidden = false
    // Anything that needs attention stays up longer.
    toastTimer = setTimeout(hideVaultToast, tone === 'ok' ? 4000 : 10_000)
  }

  /** The editor is busy only while it shows the login being deleted. */
  function showDeleteProgress() {
    const busy = deletingId !== null && deletingId === editingId
    const button = byId('edit-delete')
    button.textContent = ''
    if (busy) {
      const spinner = document.createElement('span')
      spinner.className = 'spinner'
      spinner.setAttribute('aria-hidden', 'true')
      button.appendChild(spinner)
    }
    button.append(busy ? 'Deleting…' : 'Delete login')
    button.setAttribute('aria-busy', String(busy))
    // One delete at a time, and a save must not run against a login on its way out.
    button.disabled = deletingId !== null
    byId('edit-save').disabled = busy
    byId('edit-generate').disabled = busy
  }

  async function deleteEditing() {
    if (!editingId || deletingId !== null) return
    const id = editingId
    const name = byId('edit-title').value.trim() || byId('edit-origin').value.trim()
    const username = byId('edit-username').value.trim()
    if (!window.confirm(`Delete the login “${name}”${username ? ` for ${username}` : ''}? This cannot be undone.`)) return

    deletingId = id
    hideVaultToast()
    showDeleteProgress()
    byId('edit-note').textContent = 'This can take a few seconds while relays respond.'
    let outcome
    try {
      outcome = await invoke('vault_remove', { id })
    } catch (error) {
      outcome = { ok: false, error: String(error) }
    }
    deletingId = null

    // The person may have gone back, or opened another login, while this ran.
    const stillEditing = editingId === id && !byId('password-edit').hidden
    if (editingId === id && outcome.ok) editingId = null
    showDeleteProgress()

    if (!outcome.ok) {
      const reason = outcome.error || 'Could not delete that login.'
      if (stillEditing) {
        showResult(byId('edit-note'), 'error', reason)
        byId('edit-note').scrollIntoView({ block: 'nearest' })
      } else {
        showVaultToast('error', `“${name}” was not deleted. ${reason}`)
      }
      return
    }

    showVaultToast(
      outcome.pending ? 'warn' : 'ok',
      outcome.pending
        ? `Deleted “${name}” on this device. Relay sync will retry.`
        : `Deleted “${name}”.`
    )
    if (stillEditing) showPanel('passwords')
    else await vaultSynced()
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
    deviceCredentialReply, reportFillFailure, loadPasswords, renderVaultList, vaultSynced, unlockVault, lockVault,
    handleWebauthnRequest, saveVaultConfig, renderPasswordFill, openNewLogin, renderPasswordSave, renderPasswordEdit,
    saveEdits, openPasswordEdit, deleteEditing, generateIntoEdit, respondSave, handlePasswordCapture, onPanelChange, onAppBackground,
    toggleEditPasswordReveal: () => setEditPasswordRevealed(!editPasswordRevealed)
  }
}
