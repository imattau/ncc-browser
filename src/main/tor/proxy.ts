/**
 * Tor SOCKS proxy helpers. The browser only needs a local SOCKS5 endpoint; the
 * bundled or external Tor process does the actual work.
 */

import { connect } from 'node:net'

export interface SocksEndpoint {
  host: string
  port: number
}

export function normalizeTorProxy(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new Error('Enter a SOCKS5 proxy such as socks5://127.0.0.1:9050')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('The Tor proxy is not a valid URL')
  }

  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') {
    throw new Error('The Tor proxy must use socks5:// or socks5h://')
  }
  if (url.username || url.password) {
    throw new Error('Authenticated SOCKS proxies are not supported')
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('The Tor proxy must be a host and port, without a path')
  }

  const endpoint = socksEndpointFromUrl(url)
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  return `socks5://${host}:${endpoint.port}`
}

export function socksEndpoint(proxy: string): SocksEndpoint {
  return socksEndpointFromUrl(new URL(normalizeTorProxy(proxy)))
}

function socksEndpointFromUrl(url: URL): SocksEndpoint {
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (!host) throw new Error('The Tor proxy has no host')
  const port = Number(url.port || 9050)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The Tor proxy has an invalid port')
  }
  return { host, port }
}

/**
 * PAC that sends only onion hosts to Tor. Everything else keeps the normal direct
 * path, so enabling Tor does not proxy ordinary browsing.
 */
export function buildTorPac(proxy: string): string {
  const endpoint = socksEndpoint(proxy)
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  return `function FindProxyForURL(url, host) {
  if (host === "onion" || dnsDomainIs(host, ".onion")) {
    return "SOCKS5 ${host}:${endpoint.port}";
  }
  return "DIRECT";
}
`
}

/** TCP-level SOCKS5 greeting. Confirms something is listening and speaks SOCKS5. */
export function probeSocks5(proxy: string, timeoutMs = 1500): Promise<boolean> {
  let endpoint: SocksEndpoint
  try {
    endpoint = socksEndpoint(proxy)
  } catch {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }

    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      // SOCKS5, one method: no authentication.
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    socket.once('data', (data: Buffer) => {
      finish(data.length >= 2 && data[0] === 0x05 && data[1] === 0x00)
    })
  })
}
