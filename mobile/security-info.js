export function createSecurityInfo(deps) {
  const {
    byId, icon, displayAddress, security, invoke, content, confirm, renderPill, activeKind,
    KIND_INFO, kindOf, getActiveUrl, getTabs, getActiveTabId, getPrivateSessionDetail, setSecurityState
  } = deps
  let siteClearWaiter = null
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

    if (!getActiveUrl()) {
      message('No page is open.')
      return
    }

    message('Loading…')

    try {
      const data = security.isOnionPage(getActiveUrl())
        ? security.onionInfo(getActiveUrl())
        : security.isTorWebPage(getActiveUrl())
          ? { kind: 'clearnet', host: new URL(displayAddress(getActiveUrl())).host, secure: true }
        : security.isClearnetPage(getActiveUrl())
          ? security.clearnetInfo(getActiveUrl())
          : await security.fetchInfo(getActiveUrl())
      await renderInfo(data)
      appendClearSection(data)
    } catch (error) {
      body.textContent = ''
      message(String(error))
    }
  }

  async function renderInfo(data) {
    const head = byId('info-head')
    const body = byId('info-body')
    head.textContent = ''
    body.textContent = ''

    const state = security.classifySecurity(data)
    security.cache.set(new URL(getActiveUrl()).host, state)
    setSecurityState(state)

    const badge = document.createElement('span')
    badge.className = 'info-badge'
    badge.dataset.state = state
    badge.appendChild(icon(security.SECURITY[state].lock))
    const text = document.createElement('div')
    const title = document.createElement('b')
    title.textContent = security.SECURITY[state].label
    const detail = document.createElement('small')
    detail.textContent =
      data.kind === 'clearnet'
        ? data.secure
          ? 'An HTTPS website, outside the NCC network'
          : 'This page is sent without encryption'
        : security.SECURITY[state].detail
    text.append(title, detail)
    head.append(badge, text)
    renderPill()

    // Which kind of tab this is changes what the page promises, so say it first.
    const tabKind = kindOf(getTabs().find((tab) => tab.id === getActiveTabId()))
    if (tabKind !== 'normal') {
      const note = document.createElement('div')
      note.className = 'kind-note'
      note.dataset.kind = tabKind
      const words = document.createElement('span')
      const strong = document.createElement('strong')
      strong.textContent = `${KIND_INFO[tabKind].label} tab`
      words.append(strong, document.createTextNode(` — ${KIND_INFO[tabKind].info}`))
      note.append(icon(KIND_INFO[tabKind].icon), words)
      body.appendChild(note)
    }

    if (!data.error) body.appendChild(buildChecks(data, tabKind))

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

    if (/^https?:/i.test(getActiveUrl())) {
      try {
        const origin = new URL(getActiveUrl()).origin
        const kind = activeKind()
        const protection = await invoke('protection_status', { origin, kind })
        section('Privacy protection')
        row('Level', protection.level)
        row('Blocked', `${protection.blocked} requests this session`)
        const control = document.createElement('button')
        control.type = 'button'
        control.className = 'btn tonal block'
        control.textContent = protection.excepted ? 'Restore tracker and ad protection for this site' : 'Allow trackers and ads on this site'
        control.addEventListener('click', async () => {
          try {
            await invoke('settings_set_protection_exception', { origin, allowed: !protection.excepted, kind })
            if (getActiveUrl()) content.reload()
            await loadInfo()
          } catch (error) { message(String(error)) }
        })
        body.appendChild(control)
      } catch { /* protection details are optional; page security remains visible */ }
    }

    if (data.kind === 'onion') {
      section('Onion service')
      row('Address', data.onion)
      return
    }

    if (data.kind === 'clearnet') {
      section('Website')
      row('Address', data.host)
      row('Connection', data.secure ? 'HTTPS' : 'Plain HTTP')
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
  /** The address signer trust is scoped to, the same string the proxy keys it by. */
  function trustKey(data) {
    if (data.kind === 'ncc' && data.pubkey && data.service) return `ncc://${data.pubkey}/${data.service}`
    if (data.kind === 'nsite' && data.pubkey) {
      return data.site ? `nsite://${data.pubkey}/${data.site}` : `nsite://${data.pubkey}`
    }
    return ''
  }

  function buildChecks(data, tabKind = 'normal') {
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
    if (data.kind === 'clearnet') {
      if (data.secure) add('ok', 'Encrypted', 'HTTPS, checked against the usual certificate authorities')
      else add('warn', 'Not encrypted', 'Anyone on the network can read or change this page')
      add('neutral', 'Not an NCC address', 'No locator, pinning or signer is involved')
      return wrap
    }
    if (data.kind === 'onion') {
      add('ok', 'Address authenticates the site', 'A .onion address is the service\'s own key: no certificate authority is involved')
      add('ok', 'Through Tor', 'Reached over a Tor circuit')
      add('neutral', 'Encryption', 'Plain HTTP inside an onion has no TLS layer; HTTPS adds one')
      return wrap
    }
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

    if (tabKind === 'private') add('ok', 'Private session', getPrivateSessionDetail())

    // A private tab has a throwaway key of its own, in its own listener: the trust list
    // below belongs to the normal one, so offering it here would act on the wrong thing.
    if (tabKind === 'private') {
      add('neutral', 'Signer', 'A throwaway key for this private session')
      return wrap
    }

    const signerRow = add('neutral', 'Signer', 'Asks before every signature')
    const key = trustKey(data)
    if (!key) return wrap

    const status = signerRow.querySelector('small')
    const mark = signerRow.querySelector('.check-mark')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn tonal'
    signerRow.appendChild(button)

    let confirmTimer = null
    const show = (trusted) => {
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = null
      status.textContent = trusted ? 'Signs without asking' : 'Asks before every signature'
      mark.className = trusted ? 'check-mark warn' : 'check-mark neutral'
      button.textContent = trusted ? 'Revoke' : 'Trust'
      button.dataset.trusted = trusted ? '1' : ''
    }

    show(false)
    button.disabled = true

    // Exact address, not a prefix: another service of the same identity is a different
    // trust decision.
    void invoke('signer_permissions')
      .then((trusted) => {
        show(trusted.includes(key))
        button.disabled = false
      })
      .catch(() => {
        // Signer list unavailable: the row stays informational.
        button.remove()
      })

    button.addEventListener('click', async () => {
      const trusted = button.dataset.trusted === '1'
      try {
        if (trusted) {
          await invoke('signer_revoke', { service: key })
          show(false)
          return
        }
        // Trusting is the dangerous direction, so it takes a second tap.
        if (!confirmTimer) {
          button.textContent = 'Tap again to trust'
          confirmTimer = setTimeout(() => show(false), 4000)
          return
        }
        await invoke('signer_trust', { service: key })
        show(true)
      } catch (error) {
        status.textContent = String(error)
      }
    })

    return wrap
  }

  /* ───────────────────────────── Clear site data ───────────────────────────── */


  /** Ask native to drop the site's cookies and storage; resolves with its report, or null. */
  function clearSiteDataNatively(url) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        siteClearWaiter = null
        resolve(null)
      }, 4000)
      siteClearWaiter = (report) => {
        clearTimeout(timer)
        resolve(report)
      }
      content.clearSiteData(url)
    })
  }

  /**
   * What the site left on this device, and a way to remove it. Forgetting trust is a
   * separate choice because it also takes the signer permission away, which the person
   * may want to keep when only clearing cookies.
   */
  function appendClearSection(data) {
    if (!content || typeof content.clearSiteData !== 'function') return
    const body = byId('info-body')
    const url = getActiveUrl()
    if (!url) return

    const section = document.createElement('div')
    section.className = 'site-data'

    const heading = document.createElement('p')
    heading.className = 'info-section'
    heading.textContent = 'Site data'
    const text = document.createElement('p')
    text.className = 'hint'
    text.textContent =
      'Cookies, local storage and offline data this site saved on this device. The page reloads afterwards, and you may be signed out of it.'

    const row = document.createElement('label')
    row.className = 'switch-row'
    const label = document.createElement('span')
    label.textContent = 'Also forget trust decisions for this site'
    const forget = document.createElement('input')
    forget.type = 'checkbox'
    forget.className = 'switch'
    forget.setAttribute('role', 'switch')
    row.append(label, forget)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn tonal block'
    button.textContent = 'Clear site data'
    const status = document.createElement('p')
    status.className = 'status'
    status.setAttribute('role', 'status')

    let confirmTimer = null
    const reset = () => {
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = null
      button.textContent = 'Clear site data'
    }

    button.addEventListener('click', async () => {
      // Destructive, so it takes a second tap.
      if (!confirmTimer) {
        button.textContent = 'Tap again to clear'
        confirmTimer = setTimeout(reset, 4000)
        return
      }
      reset()
      button.disabled = true
      status.textContent = 'Clearing…'

      const report = await clearSiteDataNatively(url)
      let note = report ? `Cleared ${report.cookies} cookie${report.cookies === 1 ? '' : 's'} and stored data.` : 'Cleared.'

      if (forget.checked) {
        const key = trustKey(data)
        const origin = key || (security.isClearnetPage(url) ? new URL(url).origin : '')
        try {
          if (key) await invoke('site_forget_trust', { service: key })
          if (origin) await invoke('vault_forget_never_save', { origin })
          note += ' Trust decisions forgotten.'
        } catch (error) {
          note += ` Trust could not be forgotten: ${error}`
        }
      }

      status.textContent = note
      button.disabled = false
    })

    section.append(heading, text, row, button, status)
    body.appendChild(section)
  }

  function siteClearComplete(report) {
    siteClearWaiter?.(report)
    siteClearWaiter = null
  }

  return { loadInfo, siteClearComplete }
}
