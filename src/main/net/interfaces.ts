import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { EndpointCandidate } from '@shared/reachability'
import {
  ipv4ToInt,
  isCgnatIPv4,
  isGlobalIPv6,
  isLinkLocalIPv6,
  isLoopbackHost,
  isLoopbackIPv4,
  isPrivateIPv4,
  isUniqueLocalIPv6
} from './ip-class'
import { buildUrl, endpoint, parseSeed, seedPort } from './endpoint'

/**
 * Candidate endpoints derived only from the seed URL and the interface list.
 * Loopback stays owner-only; a public interface address is not proof of inbound
 * reachability, so it is marked unverified.
 */
export interface InterfaceCandidateOptions {
  secure?: boolean
  port?: number
}

export function interfaceCandidates(
  seedUrl: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  options: InterfaceCandidateOptions = {}
): { candidates: EndpointCandidate[]; warnings: string[] } {
  const warnings: string[] = []
  const raw = seedUrl.trim()
  let seed = parseSeed(seedUrl)
  if (!seed && !raw) {
    const fallbackPort = options.port ?? (options.secure ? 443 : 80)
    seed = new URL(`${options.secure ? 'https' : 'http'}://127.0.0.1:${fallbackPort}`)
  }
  if (!seed) {
    return {
      candidates: [],
      warnings: ['This page does not have an http(s) endpoint. Add one by hand.']
    }
  }
  const secure = options.secure ?? seed.protocol === 'https:'
  const scheme: 'http' | 'https' = secure ? 'https' : 'http'
  const port = options.port ?? seedPort(seed)
  const host = seed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const candidates: EndpointCandidate[] = []
  const seen = new Set<string>()

  const add = (candidate: EndpointCandidate): void => {
    if (seen.has(candidate.url)) return
    seen.add(candidate.url)
    candidates.push(candidate)
  }

  // The page itself, when it already names a remotely usable address.
  const isOnion = host.endsWith('.onion')
  const publicHost =
    ipv4ToInt(host) !== null
      ? !isLoopbackIPv4(host) && !isPrivateIPv4(host) && !isCgnatIPv4(host) && !host.startsWith('169.254.')
      : isGlobalIPv6(host) || (host !== '' && host !== 'localhost' && !isUniqueLocalIPv6(host))
  if (isOnion) {
    add(
      endpoint(
        'onion',
        buildUrl(scheme, host, port, seed),
        'verified',
        'This page was loaded through an onion service',
        'onion'
      )
    )
  } else if (publicHost) {
    add(
      secure
        ? endpoint('current-https', buildUrl('https', host, port, seed), 'verified', 'The address this page is loaded from')
        : endpoint('public-v4', buildUrl('http', host, port, seed), 'unverified', 'Plain HTTP; the address is not confirmed reachable')
    )
  }

  const hostIsLoopback = isLoopbackHost(host)
  const hostIsLanV4 = ipv4ToInt(host) !== null && (isPrivateIPv4(host) || host.startsWith('169.254.'))
  const hostIsGlobalV6 = host.includes(':') && isGlobalIPv6(host) && !isUniqueLocalIPv6(host)
  const localSeed = hostIsLoopback || hostIsLanV4 || hostIsGlobalV6 || isOnion

  if (hostIsLanV4 || hostIsGlobalV6) {
    add(
      endpoint(
        hostIsGlobalV6 ? 'ipv6' : 'lan',
        buildUrl(scheme, host, port, seed),
        hostIsGlobalV6 ? 'firewall-dependent' : 'same-network',
        'The address this page is loaded from',
        hostIsGlobalV6 ? 'ipv6' : 'ipv4'
      )
    )
  }

  if (!localSeed) {
    warnings.push(
      'This page is already a remote address; only that address is listed. Open a local service to scan this machine.'
    )
    return { candidates, warnings }
  }

  const loopbackHost = hostIsLoopback && host !== 'localhost' ? host : '127.0.0.1'
  add(endpoint('loopback', buildUrl(scheme, loopbackHost, port, seed), 'owner-only', 'Only this machine can use it'))
  for (const alias of ['127.0.0.1', 'localhost']) {
    if (alias !== loopbackHost) {
      add(endpoint('loopback', buildUrl(scheme, alias, port, seed), 'owner-only', 'Only this machine can use it'))
    }
  }

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.internal) continue
      const address = info.address.split('%')[0]
      if (info.family === 'IPv4') {
        if (isLoopbackIPv4(address)) continue
        if (address.startsWith('169.254.')) {
          warnings.push(`${name} has a link-local address (${address}); skipped.`)
          continue
        }
        if (isPrivateIPv4(address)) {
          add(
            endpoint(
              'lan',
              buildUrl(scheme, address, port, seed),
              'same-network',
              `Reachable on the local network only (${name})`,
              'ipv4'
            )
          )
          continue
        }
        add(
          endpoint(
            'public-v4',
            buildUrl(scheme, address, port, seed),
            'unverified',
            `Interface address (${name}); requires a port forward and is not confirmed`,
            'ipv4'
          )
        )
        continue
      }
      if (info.family === 'IPv6') {
        if (isLinkLocalIPv6(address) || isUniqueLocalIPv6(address)) continue
        if (!isGlobalIPv6(address)) continue
        add(
          endpoint(
            'ipv6',
            buildUrl(scheme, address, port, seed),
            'firewall-dependent',
            `Global IPv6 (${name}); no NAT, but the firewall must allow inbound`,
            'ipv6'
          )
        )
      }
    }
  }

  if (!candidates.some((candidate) => candidate.kind !== 'loopback')) {
    warnings.push('Only this machine has an address for this endpoint; a remote recipient needs a tunnel or Tor.')
  }
  if (secure) {
    warnings.push('HTTPS is detected. The TLS certificate must match the host a recipient uses.')
  }

  return { candidates, warnings }
}
