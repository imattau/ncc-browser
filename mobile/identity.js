import { npubToHex } from './profile.js'

export function createIdentity(deps) {
  const {
    byId, set, shortId, invoke, emptyState, confirm, content, applyLayout,
    getPanel, getTabs, getIdentity, setIdentity, getBrowserSettings, setBrowserSettings,
    showPanel, closePanel,
    renderHomeIdentity, loadProfile, watchIdentityProfiles
  } = deps
  let identityProfiles = null
  let signerRequest = null
  let signerTimer = null
  let signerDeadline = 0
  let stopSettingsProfileWatch = null
  let stopChooserProfileWatch = null


  function renderIdentityProfiles(result, metadata = {}) {
    identityProfiles = result
    const list = byId('identity-profiles')
    if (!list) return
    list.replaceChildren()
    const profiles = result?.identities ?? []
    if (!profiles.length) {
      const empty = document.createElement('p')
      empty.className = 'hint'
      empty.textContent = 'No saved identities yet. Create or import a local key, or connect a remote signer below.'
      list.append(empty)
      return
    }
    for (const profile of profiles) {
      const row = document.createElement('article')
      row.className = 'identity-profile'
      const title = document.createElement('div')
      title.className = 'identity-profile-title'
      const hex = npubToHex(profile.npub)
      const meta = metadata[hex] || {}
      const header = document.createElement('div'); header.className = 'identity-profile-header'
      const image = document.createElement('img'); image.className = 'identity-profile-avatar'; image.alt = ''; image.src = meta.pictureData || ''; image.hidden = !meta.pictureData
      image.onerror = () => { image.hidden = true }
      const fallback = document.createElement('span'); fallback.className = 'identity-profile-avatar identity-profile-avatar-fallback'; fallback.textContent = (meta.name || profile.npub || '?').slice(0, 1).toUpperCase()
      fallback.hidden = Boolean(meta.pictureData)
      const labels = document.createElement('div'); labels.className = 'identity-profile-labels'
      title.textContent = meta.name || profile.npub || (profile.mode === 'nip46' ? 'Remote signer' : profile.id.replace(/^local:/, ''))
      labels.append(title)
      if (meta.name && profile.npub) { const npub = document.createElement('small'); npub.className = 'identity-profile-npub'; npub.textContent = shortId(profile.npub); labels.append(npub) }
      image.addEventListener('error', () => { fallback.hidden = false })
      header.append(image, fallback, labels)
      const detail = document.createElement('div')
      detail.className = 'identity-profile-detail'
      detail.textContent = [profile.mode === 'nip46' ? 'NIP-46 remote signer' : 'Local key', profile.active ? 'Active' : '', profile.is_default ? 'Default' : '', profile.mode === 'local' ? (profile.unlocked ? 'Unlocked' : 'Locked') : ''].filter(Boolean).join(' · ')
      row.append(header, detail)
      const actions = document.createElement('div')
      actions.className = 'identity-profile-actions'
      if (!profile.active) {
        const use = document.createElement('button')
        use.type = 'button'
        use.textContent = 'Use'
        use.addEventListener('click', async () => {
          try {
            await invoke('identity_select', { id: profile.id })
            await refreshIdentity()
            await refreshBunker()
            await refreshIdentityProfiles()
          } catch (error) { identityFailure(error) }
        })
        actions.append(use)
      }
      if (!profile.is_default) {
        const makeDefault = document.createElement('button')
        makeDefault.type = 'button'
        makeDefault.textContent = 'Make default'
        makeDefault.addEventListener('click', async () => {
          try { renderIdentityProfiles(await invoke('identity_set_default', { id: profile.id })) }
          catch (error) { identityFailure(error) }
        })
        actions.append(makeDefault)
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'danger'
      remove.textContent = 'Remove'
      remove.addEventListener('click', async () => {
        if (!confirm('Remove this identity from Nostr Navigator?')) return
        try {
          await invoke('identity_remove_profile', { id: profile.id })
          await refreshIdentity()
          await refreshBunker()
          await refreshIdentityProfiles()
        } catch (error) { identityFailure(error) }
      })
      actions.append(remove)
      row.append(actions)
      list.append(row)
    }
  }

  async function refreshIdentityProfiles() {
    try {
      const result = await invoke('identity_profiles')
      stopSettingsProfileWatch?.()
      stopSettingsProfileWatch = watchIdentityProfiles(result?.identities || [], (metadata) => renderIdentityProfiles(result, metadata))
    }
    catch (error) { identityFailure(error) }
  }

  async function openSignerChooser() {
    try {
      const result = await invoke('identity_profiles')
      if ((result?.identities || []).length <= 1) return
      const list = byId('signer-chooser-list')
      const error = byId('signer-chooser-error')
      error.textContent = ''
      list.replaceChildren()
      showPanel('signer-chooser')
      stopChooserProfileWatch?.()
      stopChooserProfileWatch = watchIdentityProfiles(result.identities, (metadata) => {
        list.replaceChildren()
        for (const item of result.identities) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'row signer-choice'; button.disabled = Boolean(item.active)
          const meta = metadata[npubToHex(item.npub)] || {}
          const image = document.createElement('img'); image.className = 'signer-choice-avatar'; image.alt = ''; image.src = meta.pictureData || ''
          image.hidden = !meta.pictureData
          const fallback = document.createElement('span'); fallback.className = 'signer-choice-avatar identity-profile-avatar-fallback'; fallback.textContent = (meta.name || item.npub || '?').slice(0, 1).toUpperCase(); fallback.hidden = Boolean(meta.pictureData)
          image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false })
          const text = document.createElement('span'); text.className = 'row-text'
          const title = document.createElement('b'); title.textContent = meta.name || item.npub || item.id
          const detail = document.createElement('small'); detail.textContent = `${meta.name && item.npub ? `${shortId(item.npub)} · ` : ''}${item.mode === 'nip46' ? 'Remote signer' : 'Local key'}${item.is_default ? ' · Default' : ''}${item.active ? ' · Active' : ''}`
          text.append(title, detail); button.append(image, fallback, text)
          button.addEventListener('click', async () => { button.disabled = true; error.textContent = ''; try { await invoke('identity_select', { id: item.id }); await refreshIdentity(); await refreshBunker(); closePanel() } catch (e) { button.disabled = false; error.textContent = String(e) } })
          list.append(button)
        }
      })
    } catch (error) {
      // A failed lookup should not interrupt the normal single-press menu.
    }
  }

  function renderIdentity(status) {
    setIdentity(status)
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

    // Keep the add-key controls visible so more than one local key can be saved.
    byId('identity-setup').hidden = false
    byId('identity-locked').hidden = !status.initialised || status.unlocked
    byId('identity-lock').hidden = !status.unlocked

    // Only an identity stored on this device can stay unlocked; there is nothing to
    // keep open otherwise.
    byId('keep-unlocked-row').hidden = !status.initialised
    byId('keep-unlocked').checked = getBrowserSettings()?.keepUnlocked === true
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
      await refreshIdentityProfiles()
    } catch (error) {
      state.textContent = `Could not read the remote signer: ${error}`
    }
  }

  async function refreshIdentity() {
    try {
      renderIdentity(await invoke('identity_status'))
      await refreshIdentityProfiles()
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
        renderIdentity(await invoke('identity_create_profile'))
        byId('identity-error').textContent = ''
        await refreshIdentityProfiles()
      } catch (error) {
        identityFailure(error)
      }
    })

    byId('identity-import-form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const button = byId('identity-import')
      const status = byId('identity-import-status')
      const error = byId('identity-error')
      const secret = byId('nsec').value.trim()
      if (!secret) {
        error.textContent = 'Paste an nsec first.'
        status.textContent = ''
        return
      }

      error.textContent = ''
      status.textContent = 'Importing identity…'
      button.disabled = true
      button.textContent = 'Importing…'
      try {
        renderIdentity(await invoke('identity_import_profile', { secret }))
        byId('nsec').value = ''
        status.textContent = 'Identity imported.'
        await refreshIdentityProfiles()
      } catch (error) {
        identityFailure(error)
        status.textContent = ''
      } finally {
        button.disabled = false
        button.textContent = 'Import'
      }
    })

    byId('identity-unlock').addEventListener('click', async () => {
      const legacy = getIdentity()?.envelope === 'legacy'
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
        setBrowserSettings(await invoke('browser_settings'))
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
      case 'payment-card-auth':
        return 'Confirm a payment card fill with your Nostr identity'
      case 'get-public-key':
      case 'getPublicKey':
        return 'Wants to read your public key'
      case 'sign-event':
      case 'signEvent':
        return `Wants you to sign an event${kind}`
      case 'nip04.encrypt':
      case 'nip44.encrypt':
      case 'nip04-encrypt':
      case 'nip44-encrypt':
        return 'Wants to encrypt a message with your key'
      case 'nip04.decrypt':
      case 'nip44.decrypt':
      case 'nip04-decrypt':
      case 'nip44-decrypt':
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
    // A throwaway key has nothing worth remembering a decision for.
    const rememberRow = byId('signer-remember').closest('.switch-row')
    if (rememberRow) rememberRow.hidden = request.ephemeral === true || request.method === 'payment-card-auth'
    byId('signer-title').textContent = request.method === 'payment-card-auth'
      ? 'Confirm card fill'
      : request.ephemeral ? 'Request (throwaway key)' : 'Signature request'
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
    if (getPanel() === 'home' && getTabs().length > 0) content?.expand(false)
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

  function stopProfileWatches() { stopSettingsProfileWatch?.(); stopSettingsProfileWatch = null; stopChooserProfileWatch?.(); stopChooserProfileWatch = null }

  return {
    hasSignerRequest: () => Boolean(signerRequest),
    setupIdentity, refreshIdentity, refreshBunker, renderIdentity, answerSigner,
    openSignerChooser, stopProfileWatches
  }
}
