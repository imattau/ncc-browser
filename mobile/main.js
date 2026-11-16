/**
 * M0 smoke test for the Tauri shell.
 *
 * Everything here answers one question: did the WebView load our bundle and can it
 * reach Rust? The content surface, `ncc://` proxying and the React chrome come later.
 */

const byId = (id) => document.getElementById(id)

function set(id, value) {
  byId(id).textContent = value
}

async function main() {
  const tauri = globalThis.__TAURI__

  if (!tauri) {
    set('bridge', 'missing')
    set('note', 'window.__TAURI__ is absent: this is a plain WebView, not the shell.')
    return
  }

  set('bridge', 'ok')

  try {
    const version = await tauri.app.getVersion()
    set('version', version)
  } catch (error) {
    set('version', `unavailable (${error?.message ?? error})`)
  }

  set('secure', globalThis.isSecureContext ? 'yes' : 'no')
  set('sw', 'serviceWorker' in navigator ? 'available' : 'absent')
  set('ua', navigator.userAgent)
}

void main()
