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

/** Events from the native content surface. */
globalThis.__nccContent = (state) => {
  const lines = [
    `${state.type}${state.title ? ` · ${state.title}` : ''}`,
    state.url ? `url: ${state.url}` : null,
    state.reason ? `reason: ${state.reason}` : null
  ].filter(Boolean)

  byId('result').textContent = lines.join('\n')

  if (state.type === 'loaded' || state.type === 'blocked' || state.type === 'failed') {
    byId('close').hidden = false
  }
  if (state.type === 'closed') {
    byId('close').hidden = true
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
}

function targetUrl(port) {
  const value = byId('address').value.trim()
  const [pubkey, service = 'addr'] = value.split('/')
  return `http://${pubkey}.${service}.localhost:${port}/`
}

function open(port) {
  const url = targetUrl(port)
  if (content) {
    byId('result').textContent = `opening ${url}`
    content.open(url)
    return
  }
  void probe(url)
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
