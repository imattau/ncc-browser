/**
 * M0 shell.
 *
 * The address field asks the platform to open a virtual host. On Android that goes
 * through `window.NccContent` — a `@JavascriptInterface` on the shell's WebView — and
 * the page appears in a real content WebView on top of the shell. In a browser or on
 * desktop, where that bridge does not exist, the same button falls back to a fetch,
 * which still proves the proxy and the `*.localhost` mapping.
 */

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

let contentOpen = false

/**
 * `http://<npub>.<service>.localhost:<port>/x` is what the content view loads; what
 * belongs in a 56 dp strip is the address the user typed.
 */
function displayAddress(url) {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('.localhost')) return url
    const labels = parsed.hostname.split('.')
    const pubkey = labels[0]
    const service = labels.length > 2 ? labels[1] : null
    return `ncc://${pubkey}${service ? `/${service}` : ''}${parsed.pathname}`
  } catch {
    return url
  }
}

/** Events from the native content surface. */
globalThis.__nccContent = (state) => {
  const lines = [
    `${state.type}${state.title ? ` · ${state.title}` : ''}`,
    state.url ? `url: ${state.url}` : null,
    state.reason ? `reason: ${state.reason}` : null
  ].filter(Boolean)

  byId('result').textContent = lines.join('\n')

  if (state.type === 'loaded' || state.type === 'blocked' || state.type === 'failed') {
    contentOpen = true
    byId('close').hidden = false
    byId('collapse').hidden = !content ? true : false
    byId('bar-address').textContent = displayAddress(state.url || '')
  }
  if (state.type === 'closed') {
    contentOpen = false
    byId('close').hidden = true
    byId('collapse').hidden = true
    byId('bar-address').textContent = 'no page'
  }
}

globalThis.__nccContentReady = () => {
  set('bridge', 'ok (content bridge)')
}

async function main() {
  const tauri = globalThis.__TAURI__

  if (!tauri) {
    set('bridge', 'missing')
    set('proxy', 'unavailable')
    byId('result').textContent =
      'window.__TAURI__ is absent: this is a plain WebView, not the shell.'
    return
  }

  set('bridge', 'ok')
  set('secure', globalThis.isSecureContext ? 'yes' : 'no')
  set('sw', 'serviceWorker' in navigator ? 'available' : 'absent')

  try {
    set('version', await tauri.app.getVersion())
  } catch {
    // Informational only.
  }

  let port = null
  try {
    port = await tauri.core.invoke('proxy_port')
  } catch (error) {
    set('proxy', `invoke failed: ${error?.message ?? error}`)
    return
  }

  if (!port) {
    set('proxy', 'not started')
    byId('go').disabled = true
    return
  }

  set('proxy', `127.0.0.1:${port}`)
  byId('go').textContent = content
    ? 'Open in the content view'
    : 'Fetch through the proxy'
  byId('go').addEventListener('click', () => open(port))
  byId('close').addEventListener('click', () => content?.close())

  byId('signer-allow').addEventListener('click', () => answerSigner(true))
  byId('signer-deny').addEventListener('click', () => answerSigner(false))
  await setupIdentity(tauri)

  if (content) {
    byId('collapse').addEventListener('click', () => content.expand(false))
    byId('bar-back').addEventListener('click', () => content.back())
    byId('bar-reload').addEventListener('click', () => content.reload())
    byId('bar-address').addEventListener('click', () => {
      content.expand(true)
      byId('address').focus()
    })
    window.addEventListener('resize', applyLayout)
    applyLayout()
  }
}

/**
 * Accept what a person actually pastes: `ncc://npub…/service`, `npub…/service`,
 * a hex key, or a bare key for the default service.
 */
/**
 * The strip is the same page at 56 dp. Which half renders is decided by the viewport
 * the shell hands us, so no extra bridge call is needed to know the mode.
 */
/** Identity status drives which of the three panels is visible. */
let identity = null
let signerRequest = null

function renderIdentity(status) {
  identity = status
  const state = byId('identity-state')

  if (!status.initialised) {
    state.textContent = 'No identity on this device yet.'
  } else if (status.unlocked) {
    state.textContent = `Unlocked: ${status.npub}`
  } else {
    state.textContent = `Locked: ${status.npub}`
  }

  byId('identity-setup').hidden = status.initialised
  byId('identity-locked').hidden = !status.initialised || status.unlocked
  byId('identity-lock').hidden = !status.unlocked
}

async function refreshIdentity() {
  try {
    renderIdentity(await globalThis.__TAURI__.core.invoke('identity_status'))
  } catch (error) {
    byId('identity-state').textContent = `Identity unavailable: ${error}`
  }
}

function identityFailure(error) {
  byId('identity-error').textContent = String(error)
}

async function setupIdentity(tauri) {
  const invoke = tauri.core.invoke

  byId('identity-create').addEventListener('click', async () => {
    const passphrase = byId('passphrase').value
    if (passphrase.length < 8) {
      identityFailure('Use at least 8 characters.')
      return
    }
    try {
      renderIdentity(await invoke('identity_create', { passphrase }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-import').addEventListener('click', async () => {
    const passphrase = byId('passphrase').value
    const secret = byId('nsec').value.trim()
    if (passphrase.length < 8 || !secret) {
      identityFailure('A passphrase of at least 8 characters and an nsec are required.')
      return
    }
    try {
      renderIdentity(await invoke('identity_import', { passphrase, secret }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-unlock').addEventListener('click', async () => {
    try {
      renderIdentity(await invoke('identity_unlock', { passphrase: byId('unlock-passphrase').value }))
      byId('identity-error').textContent = ''
    } catch (error) {
      identityFailure(error)
    }
  })

  byId('identity-lock').addEventListener('click', async () => {
    renderIdentity(await invoke('identity_lock'))
  })

  await tauri.event.listen('ncc:signer', (event) => showSigner(event.payload))
  await refreshIdentity()
}

/** A page is waiting on an answer, so take the window until it has one. */
function showSigner(request) {
  signerRequest = request
  byId('signer-service').textContent = request.service
  byId('signer-method').textContent =
    request.method + (request.kind ? ` · kind ${request.kind}` : '')
  byId('signer-preview').textContent = request.preview || '(nothing to show)'
  byId('signer').hidden = false
  byId('signer-remember').checked = false
  content?.expand(true)
}

async function answerSigner(allow) {
  if (!signerRequest) return
  const request = signerRequest
  signerRequest = null

  try {
    await globalThis.__TAURI__.core.invoke('signer_respond', {
      id: request.id,
      allow,
      remember: byId('signer-remember').checked,
      service: request.service
    })
  } catch {
    // The request is gone either way; the page sees its own error.
  }

  byId('signer').hidden = true
  if (contentOpen) content?.expand(false)
}

function applyLayout() {
  const compact = window.innerHeight < 200
  document.body.classList.toggle('compact', compact)
  byId('bar').hidden = !compact
  if (!compact && contentOpen) byId('collapse').hidden = false
}

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

function targetUrl(port) {
  const parsed = parseAddress(byId('address').value)
  if (parsed.error) return { error: parsed.error }
  return { url: `http://${parsed.pubkey}.${parsed.service}.localhost:${port}/` }
}

function open(port) {
  const target = targetUrl(port)
  if (target.error) {
    byId('result').textContent = target.error
    return
  }

  byId('close').hidden = true
  byId('result').textContent = `opening ${target.url}`

  if (content) {
    content.expand(false)
    content.open(target.url)
    return
  }
  void probe(target.url)
}

async function probe(url) {
  byId('result').textContent = `GET ${url}\n…`
  const started = performance.now()

  try {
    const response = await fetch(url, { cache: 'no-store' })
    const body = await response.text()
    const elapsed = Math.round(performance.now() - started)

    byId('result').textContent = [
      `${response.status} ${response.statusText} · ${elapsed} ms`,
      `content-type: ${response.headers.get('content-type') ?? 'none'}`,
      `url: ${url}`,
      '',
      summarise(body) || '(empty body)'
    ].join('\n')
  } catch (error) {
    byId('result').textContent = [
      'fetch failed',
      `url: ${url}`,
      '',
      String(error?.message ?? error)
    ].join('\n')
  }
}

void main()
