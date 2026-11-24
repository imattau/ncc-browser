export function createSecurity({ getProxyPort }) {
  const SECURITY = {
    pinned: { label: 'Secure', detail: 'Pinned certificate matches the locator', lock: 'shield-check' },
    tls: { label: 'Secure', detail: 'HTTPS endpoint', lock: 'shield-check' },
    verified: { label: 'Verified', detail: 'Site files are checked against their hashes', lock: 'shield-check' },
    onion: { label: 'Onion service', detail: 'Reached through a Tor onion endpoint', lock: 'shield-check' },
    plain: { label: 'Not secure', detail: 'This service is only offered over cleartext HTTP', lock: 'shield-alert' },
    'certificate-error': { label: 'Certificate error', detail: 'The browser blocked this connection because it could not verify the website certificate', lock: 'shield-alert' },
    failure: { label: 'Page failed', detail: 'The page could not be loaded', lock: 'shield-alert' },
    unknown: { label: 'Unverified', detail: 'No endpoint information yet', lock: 'shield' }
  }

  const cache = new Map()

  function classifySecurity(data) {
    if (!data || data.error) return 'unknown'
    if (data.kind === 'certificate-error') return 'certificate-error'
    if (data.kind === 'nsite') return 'verified'
    if (data.kind === 'onion') return 'onion'
    if (data.kind === 'clearnet') return data.secure ? 'tls' : 'plain'
    const endpoints = data.endpoints || []
    if (endpoints.some((endpoint) => endpoint.pinned)) return 'pinned'
    if (endpoints.some((endpoint) => /https/i.test(endpoint.protocol || ''))) return 'tls'
    if (endpoints.some((endpoint) => endpoint.family === 'onion')) return 'onion'
    if (endpoints.length > 0) return 'plain'
    return 'unknown'
  }

  /**
   * Ask the listener that serves this tab. A private tab is served by its own listener
   * (and resolver), so asking the normal one would resolve and cache the service in the
   * session the tab exists to stay out of.
   */
  async function fetchInfo(url) {
    const parsed = new URL(url)
    const port = parsed.port || getProxyPort()
    const response = await fetch(`http://127.0.0.1:${port}/__ncc/info?u=${encodeURIComponent(parsed.host)}`)
    return response.json()
  }

  /** An onion page: the proxy has no record to report, the address is the whole story. */
  function isOnionPage(url) {
    try {
      return new URL(url).hostname.endsWith('.onion.localhost')
    } catch {
      return false
    }
  }

  /** A website a Tor tab loaded through the Tor listener. */
  function isTorWebPage(url) {
    try {
      return new URL(url).hostname.endsWith('.tor.localhost')
    } catch {
      return false
    }
  }

  /** A page loaded straight from the web: no record to ask the proxy about. */
  function isClearnetPage(url) {
    try {
      return !new URL(url).hostname.endsWith('.localhost')
    } catch {
      return false
    }
  }

  function clearnetInfo(url) {
    const parsed = new URL(url)
    return { kind: 'clearnet', host: parsed.host, secure: parsed.protocol === 'https:' }
  }

  function onionInfo(url) {
    const host = new URL(url).hostname.replace(/\.localhost$/, '')
    return { kind: 'onion', onion: host }
  }

  async function securityFor(url) {
    if (!url) return 'unknown'

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return 'unknown'
    }

    // Nothing to resolve for a clearnet page, so nothing can be pinned or verified:
    // whether it is TLS is answered by the URL itself.
    if (!parsed.hostname.endsWith('.localhost')) {
      return parsed.protocol === 'https:' ? 'tls' : 'plain'
    }

    if (isOnionPage(url)) return 'onion'
    // The listener checks the certificate against the web roots before serving anything.
    if (isTorWebPage(url)) return 'tls'

    if (!getProxyPort()) return 'unknown'
    const key = parsed.host
    if (cache.has(key)) return cache.get(key)
    try {
      const state = classifySecurity(await fetchInfo(url))
      cache.set(key, state)
      return state
    } catch {
      return 'unknown'
    }
  }

  return {
    SECURITY, cache, classifySecurity, fetchInfo, isOnionPage, isTorWebPage,
    isClearnetPage, clearnetInfo, onionInfo, securityFor
  }
}
