/**
 * Fetch a package from a URL a stranger chose. HTTPS to public addresses only, checked
 * on every redirect and on the address actually connected to, with a size limit.
 * Sends no cookies or referrer. It does not use the system proxy or Tor.
 */

import { lookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 60_000

const blocked = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3]
] as const) {
  blocked.addSubnet(network, bits, 'ipv4')
}

const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
// Inside global unicast, but able to smuggle in a private IPv4 address, or not routed.
for (const [network, bits] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16]
] as const) {
  blocked.addSubnet(network, bits, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
  return false
}

/** Throws unless the URL is HTTPS and does not name a private address outright. */
export function checkDownloadUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Packages can only be downloaded over HTTPS without credentials')
  }
  // A literal address never reaches the DNS lookup, so it is checked here.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) throw new Error('Refusing to download from a private address')
  return url
}

/** Resolves a host for the socket itself, so the checked address is the one used. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, result) => {
    const addresses = (result ?? []) as LookupAddress[]
    const refused =
      error ??
      (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))
        ? new Error('Refusing to download from a private address')
        : null)
    if (refused) return callback(refused, '', 4)
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

export async function downloadPublic(value: string, maxBytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let url = checkDownloadUrl(value)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await get(url, maxBytes, signal)
    if (Buffer.isBuffer(result)) return result
    url = checkDownloadUrl(new URL(result.location, url).toString())
  }
  throw new Error('The download redirected too many times')
}

function get(url: URL, maxBytes: number, signal: AbortSignal): Promise<Buffer | { location: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { agent: false, lookup: publicLookup, signal }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy()
        resolve({ location: response.headers.location })
        return
      }
      if (status !== 200) {
        response.destroy()
        reject(new Error(`The download failed with HTTP ${status}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          response.destroy()
          reject(new Error('The download is larger than the package limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.complete) resolve(Buffer.concat(chunks))
        else reject(new Error('The download was interrupted'))
      })
      response.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}
