const SVG_NS = 'http://www.w3.org/2000/svg'
const ICONS_KEY = 'ncc.icons'

/** An icon from the sprite in index.html. */
function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', `i ${className}`.trim())
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.appendChild(use)
  return svg
}

function setIcon(svg, name) {
  svg.querySelector('use')?.setAttribute('href', `#i-${name}`)
}

/* ───────────────────────────── Addresses ───────────────────────────── */

/**
 * `http://<npub>.<service>.localhost:<port>/x` is what the content view loads; what
 * belongs in a 56 dp strip is the address the user typed.
 */
function displayAddress(url) {
  try {
    const parsed = new URL(url)

    if (parsed.hostname.endsWith('.onion.localhost')) {
      // The vhost is this listener's spelling; the address the user typed is the
      // onion, with its `.localhost` suffix removed.
      const host = parsed.hostname.slice(0, -'.localhost'.length)
      return `http://${host}${parsed.pathname}${parsed.search}`
    }

    if (parsed.hostname.endsWith('.tor.localhost')) {
      // A website a Tor tab opened: `<host>[.p<port>].tor.localhost` is its https address.
      const m = /^(.+?)(?:\.p(\d+))?\.tor\.localhost$/.exec(parsed.hostname)
      if (m) {
        return `https://${m[1]}${m[2] ? `:${m[2]}` : ''}${parsed.pathname}${parsed.search}`
      }
    }

    if (parsed.hostname.endsWith('.nsite.localhost')) {
      // pubkey.site.nsite.localhost, or pubkey.nsite.localhost for the root site.
      const labels = parsed.hostname.split('.')
      const pubkey = labels[0]
      const site = labels.length === 4 ? labels[1] : null
      return `nsite://${pubkey}${site ? `/${site}` : ''}${parsed.pathname}${parsed.search}${parsed.hash}`
    }

    if (!parsed.hostname.endsWith('.localhost')) return url
    const labels = parsed.hostname.split('.')
    const pubkey = labels[0]
    const service = labels.length > 2 ? labels[1] : null
    return `ncc://${pubkey}${service ? `/${service}` : ''}${parsed.pathname}`
  } catch {
    return url
  }
}

function shortId(id) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

/** Split an address into the identity (kept) and the rest (what the pill truncates). */
function addressParts(url) {
  const address = displayAddress(url)
  const match = address.match(/^(ncc|nsite):\/\/([^/]+)(\/.*)?$/i)
  if (match) {
    return { scheme: match[1].toLowerCase(), id: shortId(match[2]), rest: (match[3] || '').replace(/\/$/, '') }
  }
  try {
    const parsed = new URL(address)
    return { scheme: parsed.protocol.replace(':', ''), id: parsed.host, rest: parsed.pathname.replace(/\/$/, '') }
  } catch {
    return { scheme: '', id: address, rest: '' }
  }
}

/** A short human label for an entry: its title, else the service, else the identity. */
function labelFor(entry) {
  if (entry.title) return entry.title
  const parts = addressParts(entry.address)
  const service = parts.rest.split('/')[1]
  return service || parts.id
}

/** Favicons are kept per service (`ncc://<id>/<service>`), not per page. */
function iconKey(address) {
  const match = String(address).match(/^((?:ncc|nsite):\/\/[^/]+(?:\/[^/]+)?)/i)
  return match ? match[1] : String(address)
}

function readIcons() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(ICONS_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function saveIcon(address, dataUrl) {
  const icons = readIcons()
  const key = iconKey(address)
  delete icons[key] // re-insert so the most recent sit last
  icons[key] = dataUrl
  const keys = Object.keys(icons)
  for (const stale of keys.slice(0, Math.max(0, keys.length - 60))) delete icons[stale]
  try {
    globalThis.localStorage?.setItem(ICONS_KEY, JSON.stringify(icons))
  } catch {
    // Quota or unavailable: the letter avatar is the fallback.
  }
}

/**
 * The service's own icon when the page has supplied one, otherwise a gradient tile
 * with its initial. Both are the same box, so a late icon swaps in without reflow.
 */
function avatar(text, className = '', address = '') {
  const element = document.createElement('span')
  element.className = `avatar ${className}`.trim()

  const stored = address ? readIcons()[iconKey(address)] : null
  if (stored) {
    const image = document.createElement('img')
    image.src = stored
    image.alt = ''
    image.draggable = false
    element.classList.add('has-icon')
    element.appendChild(image)
    return element
  }

  const letter = (text.match(/[a-z0-9]/i)?.[0] || 'N').toUpperCase()
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  element.style.background = `linear-gradient(135deg, hsl(${hue} 68% 52%), hsl(${(hue + 42) % 360} 72% 40%))`
  element.textContent = letter
  return element
}


export { addressParts, avatar, displayAddress, icon, iconKey, labelFor, saveIcon, setIcon, shortId }
