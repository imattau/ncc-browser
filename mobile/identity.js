export function createIdentity(deps) {
  const {
    byId, set, shortId, invoke, emptyState, confirm, content, applyLayout,
    getPanel, getTabs, getIdentity, setIdentity, getBrowserSettings, setBrowserSettings,
    showPanel, closePanel,
    renderHomeIdentity, loadProfile
  } = deps
  let identityProfiles = null
  let signerRequest = null
  let signerTimer = null
  let signerDeadline = 0


  function renderIdentityProfiles(result) {
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
      title.textContent = profile.npub || (profile.mode === 'nip46' ? 'Remote signer' : profile.id.replace(/^local:/, ''))
      const detail = document.createElement('div')
      detail.className = 'identity-profile-detail'
      detail.textContent = [profile.mode === 'nip46' ? 'NIP-46 remote signer' : 'Local key', profile.active ? 'Active' : '', profile.is_default ? 'Default' : '', profile.mode === 'local' ? (profile.unlocked ? 'Unlocked' : 'Locked') : ''].filter(Boolean).join(' · ')
      row.append(title, detail)
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
    try { renderIdentityProfiles(await invoke('identity_profiles')) }
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
      for (const profile of result.identities) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'row signer-choice'
        button.disabled = Boolean(profile.active)
        const mark = document.createElement('span')
        mark.className = 'signer-choice-mark'
        mark.textContent = profile.active ? '✓' : profile.mode === 'nip46' ? '↗' : '○'
        const text = document.createElement('span')
        text.className = 'row-text'
        const title = document.createElement('b')
        title.textContent = profile.npub || profile.id
        const detail = document.createElement('small')
        detail.textContent = `${profile.mode === 'nip46' ? 'Remote signer' : 'Local key'}${profile.is_default ? ' · Default' : ''}${profile.active ? ' · Active' : ''}`
        text.append(title, detail)
        button.append(mark, text)
        button.addEventListener('click', async () => {
          button.disabled = true
          error.textContent = ''
          try {
            await invoke('identity_select', { id: profile.id })
            await refreshIdentity()
            await refreshBunker()
            closePanel()
          } catch (selectionError) {
            button.disabled = false
            error.textContent = String(selectionError)
          }
        })
        list.append(button)
      }
      showPanel('signer-chooser')
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

    byId('identity-import').addEventListener('click', async () => {
      const secret = byId('nsec').value.trim()
      if (!secret) {
        identityFailure('Paste an nsec first.')
        return
      }
      try {
        renderIdentity(await invoke('identity_import_profile', { secret }))
        byId('nsec').value = ''
        byId('identity-error').textContent = ''
        await refreshIdentityProfiles()
      } catch (error) {
        identityFailure(error)
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

  return {
    hasSignerRequest: () => Boolean(signerRequest),
    setupIdentity, refreshIdentity, refreshBunker, renderIdentity, answerSigner,
    openSignerChooser
  }
}
