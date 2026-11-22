/**
 * Endpoint discovery for hosted services.
 *
 * Nothing here changes the `ncc://` address: discovery only proposes endpoint
 * candidates the publisher may advertise. Only local information is used:
 * the current page URL, the host's network interfaces and the local gateway.
 * Contacting an external address service is a later, explicit opt-in.
 */

import { execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { normalizeEndpointSeed } from '@shared/reachability'
import type {
  EndpointCandidate,
  EndpointKind,
  ExternalCheckState,
  GatewayReport,
  ReachabilityReport,
  WanClass
} from '@shared/reachability'
import type { PublicAddress } from './public-address'
import { requestText } from '../http-text'

export interface DiscoverOptions {
  seedUrl: string
  /** Skip the local gateway query (tests, and when the publisher says no). */
  gateway?: boolean
  /** Run the opt-in public address lookup. */
  external?: boolean
  lookupPublicAddress?: () => Promise<PublicAddress>
  /** Force https candidates (a TLS pin is configured). */
  secure?: boolean
  /** Override the service port when the seed has none. */
  port?: number
  timeoutMs?: number
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
}

const PRIVATE_V4 = [
  { base: '10.0.0.0', bits: 8 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.168.0.0', bits: 16 }
]

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(address)
  const start = ipv4ToInt(base)
  if (value === null || start === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (start & mask)
}

export function isPrivateIPv4(address: string): boolean {
  return PRIVATE_V4.some((range) => inV4Range(address, range.base, range.bits))
}

export function isCgnatIPv4(address: string): boolean {
  return inV4Range(address, '100.64.0.0', 10)
}

export function isLoopbackIPv4(address: string): boolean {
  return inV4Range(address, '127.0.0.0', 8)
}

export function isLoopbackHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || isLoopbackIPv4(value)
}

export function isLinkLocalIPv6(address: string): boolean {
  const value = address.toLowerCase()
  return value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
}

export function isUniqueLocalIPv6(address: string): boolean {
  const value = address.toLowerCase()
  // fc00::/7
  return value.startsWith('fc') || value.startsWith('fd')
}

/** Global unicast: 2000::/3. Everything else is not a public host address. */
export function isGlobalIPv6(address: string): boolean {
  const value = address.toLowerCase()
  return /^[23]/.test(value) && !isLinkLocalIPv6(value)
}

export function classifyWanAddress(address: string | undefined): WanClass {
  if (!address) return 'unknown'
  const value = address.trim()
  if (!value || value === '0.0.0.0') return 'unknown'
  if (isLoopbackIPv4(value)) return 'loopback'
  if (isCgnatIPv4(value)) return 'cgnat'
  if (isPrivateIPv4(value)) return 'private'
  if (value.startsWith('169.254.')) return 'link-local'
  if (ipv4ToInt(value) !== null) return 'public'
  const first = value.toLowerCase()
  if (first === '::1') return 'loopback'
  if (isLinkLocalIPv6(first)) return 'link-local'
  if (isUniqueLocalIPv6(first)) return 'private'
  return 'public'
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function endpoint(
  kind: EndpointKind,
  url: string,
  confidence: EndpointCandidate['confidence'],
  note?: string,
  family?: EndpointCandidate['family']
): EndpointCandidate {
  return {
    kind,
    url,
    ...(family ? { family } : {}),
    confidence,
    source: kind === 'current-https' || kind === 'public-v4' ? 'page' : 'interface',
    ...(note ? { note } : {})
  }
}

function parseSeed(seedUrl: string): URL | null {
  const normalized = normalizeEndpointSeed(seedUrl)
  if (!normalized) return null
  try {
    return new URL(normalized)
  } catch {
    return null
  }
}

function seedPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function buildUrl(scheme: 'http' | 'https', host: string, port: number, seed: URL): string {
  const suffix = `${seed.pathname || '/'}${seed.search || ''}`
  return `${scheme}://${formatHost(host)}:${port}${suffix}`
}

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

export function gatewayWarnings(report: GatewayReport): string[] {
  const warnings: string[] = []
  switch (report.wanClass) {
    case 'cgnat':
      warnings.push(
        'The router WAN address is in 100.64.0.0/10 (carrier-grade NAT). Direct IPv4 needs a tunnel or a Tor onion endpoint.'
      )
      break
    case 'private':
      warnings.push(
        'The router WAN address is private, so there is another NAT layer (double NAT). Confirm the public address before advertising IPv4.'
      )
      break
    case 'link-local':
      warnings.push('The router reported a link-local WAN address; direct IPv4 is unlikely to work.')
      break
    case 'public':
      warnings.push('The router reports a public WAN address. A port still has to be forwarded and confirmed.')
      break
    case 'loopback':
    case 'unknown':
      if (report.error) warnings.push(`Could not read the router WAN address: ${report.error}`)
      break
  }
  return warnings
}

function emptyGateway(error?: string, upnp = false): GatewayReport {
  return {
    wanClass: 'unknown',
    upnp,
    natPmp: false,
    pcp: false,
    mappingAvailable: false,
    ...(error ? { error } : {})
  }
}

export interface UpnpGateway {
  serviceType: string
  controlUrl: string
  externalAddress?: string
}

/** Find the router's WAN control service from its device description. */
export async function findUpnpGateway(timeoutMs: number): Promise<UpnpGateway | null> {
  const location = await ssdpLocation(timeoutMs)
  if (!location) return null
  try {
    const description = await fetchText(location, timeoutMs)
    const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(description)?.[1] ?? location
    const service = /<service>([\s\S]*?)<\/service>/gi
    let controlUrl = ''
    let serviceType = ''
    for (const match of description.matchAll(service)) {
      const block = match[1]
      const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1] ?? ''
      if (!/WANIPConnection|WANPPPConnection/i.test(type)) continue
      controlUrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1] ?? ''
      serviceType = type
      if (controlUrl) break
    }
    if (!controlUrl || !serviceType) return null
    return { serviceType, controlUrl: new URL(controlUrl, base).toString() }
  } catch {
    return null
  }
}

function xml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function soapAction(
  gateway: UpnpGateway,
  action: string,
  args: Array<[string, string | number]>,
  timeoutMs: number
): Promise<string> {
  const values = args.map(([name, value]) => `<${name}>${xml(value)}</${name}>`).join('')
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${gateway.serviceType}">${values}</u:${action}></s:Body></s:Envelope>`
  return fetchText(gateway.controlUrl, timeoutMs, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${gateway.serviceType}#${action}"`,
      Connection: 'close'
    },
    body
  })
}

export interface PortMappingRequest {
  externalPort: number
  internalPort: number
  internalClient: string
  protocol?: 'TCP' | 'UDP'
  description?: string
  leaseSeconds?: number
}

/** Ask the router to forward a TCP/UDP port to a LAN client. */
export async function addUpnpPortMapping(
  gateway: UpnpGateway,
  request: PortMappingRequest,
  timeoutMs = 4000
): Promise<void> {
  await soapAction(
    gateway,
    'AddPortMapping',
    [
      ['NewRemoteHost', ''],
      ['NewExternalPort', request.externalPort],
      ['NewProtocol', request.protocol ?? 'TCP'],
      ['NewInternalPort', request.internalPort],
      ['NewInternalClient', request.internalClient],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', request.description ?? 'Nostr Navigator'],
      ['NewLeaseDuration', request.leaseSeconds ?? 7200]
    ],
    timeoutMs
  )
}

export async function deleteUpnpPortMapping(
  gateway: UpnpGateway,
  externalPort: number,
  protocol: 'TCP' | 'UDP' = 'TCP',
  timeoutMs = 4000
): Promise<void> {
  await soapAction(
    gateway,
    'DeletePortMapping',
    [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol]
    ],
    timeoutMs
  )
}

export async function upnpExternalAddressOn(
  gateway: UpnpGateway,
  timeoutMs = 4000
): Promise<string | null> {
  try {
    const response = await soapAction(gateway, 'GetExternalIPAddress', [], timeoutMs)
    return /<NewExternalIPAddress>\s*([^<]+?)\s*<\/NewExternalIPAddress>/i.exec(response)?.[1] ?? null
  } catch {
    return null
  }
}

/** Read a device description and run `GetExternalIPAddress` against its WAN service. */
export async function upnpExternalAddress(
  timeoutMs: number
): Promise<{ address: string; mapping: boolean; gateway: UpnpGateway } | null> {
  const gateway = await findUpnpGateway(timeoutMs)
  if (!gateway) return null
  const address = await upnpExternalAddressOn(gateway, timeoutMs)
  if (!address) return null
  gateway.externalAddress = address
  return { address, mapping: true, gateway }
}

async function fetchText(
  url: string,
  timeoutMs: number,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<string> {
  const response = await requestText(url, {
    timeoutMs,
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {})
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.text
}

function ssdpLocation(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createSocket({ type: 'udp4' })
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(value)
    }
    socket.on('error', () => finish(null))
    socket.on('message', (data) => {
      const text = data.toString('utf8')
      const location = /^location:\s*(\S+)/im.exec(text)?.[1]
      if (location && /IGD|InternetGatewayDevice/i.test(text)) finish(location)
    })
    socket.bind(() => {
      const query = Buffer.from(
        [
          'M-SEARCH * HTTP/1.1',
          'HOST: 239.255.255.250:1900',
          'MAN: "ssdp:discover"',
          'MX: 2',
          'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
          '',
          ''
        ].join('\r\n')
      )
      socket.send(query, 1900, '239.255.255.250')
      socket.send(query, 1900, '239.255.255.250')
    })
    setTimeout(() => finish(null), timeoutMs)
  })
}

/** Linux default gateway from /proc/net/route, used for a NAT-PMP query. */
export function linuxDefaultGateway(): string | null {
  try {
    const lines = readFileSync('/proc/net/route', 'utf8').split('\n')
    for (const line of lines.slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 4) continue
      if (fields[1] !== '00000000') continue
      const flags = Number.parseInt(fields[3], 16)
      if (!(flags & 0x2)) continue
      const hex = fields[2]
      const bytes = [3, 2, 1, 0].map((index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
      return bytes.join('.')
    }
  } catch {
    // not Linux, or unreadable
  }
  return null
}

/** The default gateway for NAT-PMP, on platforms we can read it from. */
export function defaultGateway(): string | null {
  const linux = linuxDefaultGateway()
  if (linux) return linux
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('netstat', ['-rn', '-f', 'inet'], {
        encoding: 'utf8',
        timeout: 2000
      })
      for (const line of output.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields[0] === 'default' && ipv4ToInt(fields[1] ?? '') !== null) return fields[1]
      }
    } else if (process.platform === 'win32') {
      const output = execFileSync('route', ['print', '-4'], { encoding: 'utf8', timeout: 3000 })
      for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/)
        if (fields[0] === '0.0.0.0' && ipv4ToInt(fields[2] ?? '') !== null) return fields[2]
      }
    }
  } catch {
    // no route tool or unexpected output
  }
  return null
}

export interface NatPmpMapRequest {
  internalPort: number
  externalPort?: number
  protocol?: 'TCP' | 'UDP'
  lifetimeSeconds?: number
}

export function encodeNatPmpMap(request: NatPmpMapRequest): {
  packet: Buffer
  opcode: number
} {
  const opcode = request.protocol === 'UDP' ? 1 : 2
  const lifetime = Math.max(0, Math.min(0xffffffff, request.lifetimeSeconds ?? 7200))
  const packet = Buffer.alloc(12)
  packet[1] = opcode
  packet.writeUInt16BE(request.internalPort, 4)
  packet.writeUInt16BE(request.externalPort ?? request.internalPort, 6)
  packet.writeUInt32BE(lifetime, 8)
  return { packet, opcode }
}

export function parseNatPmpMapResponse(data: Buffer, opcode: number): number | null {
  if (data.length < 16 || data[1] !== opcode + 128 || data.readUInt16BE(2) !== 0) return null
  return data.readUInt16BE(10)
}

/** NAT-PMP mapping request (RFC 6886). Returns the external port the router granted. */
export function natPmpMapPort(
  gateway: string,
  request: NatPmpMapRequest,
  timeoutMs = 2500
): Promise<number> {
  const { packet, opcode } = encodeNatPmpMap(request)
  return natPmpRequest(gateway, packet, opcode, timeoutMs, (data) => {
    const port = parseNatPmpMapResponse(data, opcode)
    if (port === null) throw new Error('NAT-PMP returned an invalid mapping response')
    return port
  })
}

/** Ask NAT-PMP to drop a mapping by replacing it with a zero lifetime. */
export function natPmpDeletePort(
  gateway: string,
  externalPort: number,
  timeoutMs = 2000
): Promise<number> {
  const packet = Buffer.alloc(12)
  packet[1] = 2
  packet.writeUInt16BE(0, 4)
  packet.writeUInt16BE(externalPort, 6)
  packet.writeUInt32BE(0, 8)
  return natPmpRequest(gateway, packet, 2, timeoutMs, () => externalPort)
}

function natPmpRequest<T>(
  gateway: string,
  packet: Buffer,
  opcode: number,
  timeoutMs: number,
  read: (data: Buffer) => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    let settled = false
    const finish = (error: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // ignore
      }
      if (error) reject(error)
      else resolve(value as T)
    }
    socket.on('error', (error) => finish(error))
    socket.on('message', (data) => {
      if (data.length < 16 || data[1] !== opcode + 128) {
        return finish(new Error('NAT-PMP returned an unexpected response'))
      }
      const result = data.readUInt16BE(2)
      if (result !== 0) {
        return finish(new Error(`NAT-PMP error ${result}`))
      }
      try {
        finish(null, read(data))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.send(packet, 5351, gateway, (error) => {
      if (error) finish(error)
    })
    setTimeout(() => finish(new Error('NAT-PMP did not answer')), timeoutMs)
  })
}

/** NAT-PMP public address request (RFC 6886). */
export function natPmpExternalAddress(gateway: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(value)
    }
    socket.on('error', () => finish(null))
    socket.on('message', (data) => {
      if (data.length < 12 || data[1] !== 128) return finish(null)
      const result = data.readUInt16BE(2)
      if (result !== 0) return finish(null)
      finish(`${data[8]}.${data[9]}.${data[10]}.${data[11]}`)
    })
    socket.send(Buffer.from([0, 0]), 5351, gateway, (error) => {
      if (error) finish(null)
    })
    setTimeout(() => finish(null), timeoutMs)
  })
}

export async function queryGateway(
  options: { timeoutMs?: number; interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]> } = {}
): Promise<GatewayReport> {
  const timeoutMs = Math.max(400, options.timeoutMs ?? 1600)
  const upnp = await upnpExternalAddress(timeoutMs)
  if (upnp) {
    return {
      wanAddress: upnp.address,
      wanClass: classifyWanAddress(upnp.address),
      upnp: true,
      natPmp: false,
      pcp: false,
      mappingAvailable: upnp.mapping
    }
  }

  const gateway = linuxDefaultGateway()
  if (gateway) {
    const address = await natPmpExternalAddress(gateway, Math.min(timeoutMs, 1000))
    if (address) {
      return {
        wanAddress: address,
        wanClass: classifyWanAddress(address),
        upnp: false,
        natPmp: true,
        pcp: false,
        mappingAvailable: true
      }
    }
  }

  return emptyGateway(
    gateway
      ? 'No UPnP or NAT-PMP reply from the router.'
      : 'No UPnP reply and no default gateway could be read.'
  )
}

const GATEWAY_TTL_MS = 5 * 60_000
let gatewayCache: { at: number; report: GatewayReport } | null = null

export async function discoverReachability(options: DiscoverOptions): Promise<ReachabilityReport> {
  const { candidates, warnings } = interfaceCandidates(options.seedUrl, options.interfaces, {
    ...(options.secure === undefined ? {} : { secure: options.secure }),
    ...(options.port === undefined ? {} : { port: options.port })
  })
  const local = candidates.some(
    (candidate) =>
      candidate.kind === 'loopback' ||
      candidate.kind === 'lan' ||
      candidate.kind === 'ipv6' ||
      candidate.kind === 'onion'
  )

  let gateway: GatewayReport
  if (options.gateway === false || !local) {
    gateway = options.gateway === false ? emptyGateway('Gateway check skipped.') : emptyGateway()
  } else if (gatewayCache && Date.now() - gatewayCache.at < GATEWAY_TTL_MS) {
    gateway = gatewayCache.report
  } else {
    gateway = await queryGateway(options)
    gatewayCache = { at: Date.now(), report: gateway }
  }

  let externalCheck: ExternalCheckState = 'not-run'
  let externalAddress: string | undefined
  let externalProvider: string | undefined
  if (options.external && options.lookupPublicAddress) {
    try {
      const found = await options.lookupPublicAddress()
      externalAddress = found.address
      externalProvider = found.provider
      if (found.family === 'ipv6') {
        externalCheck = 'confirmed'
        warnings.push(
          `The public lookup returned ${found.address} (IPv6). Inbound IPv6 uses the host's global address, not NAT; check the firewall.`
        )
      } else {
        if (gateway.wanAddress) {
          externalCheck = gateway.wanAddress === found.address ? 'matched' : 'mismatch'
          warnings.push(
            externalCheck === 'matched'
              ? `The internet sees ${found.address}, matching the router WAN. A port still needs forwarding.`
              : `The router reports ${gateway.wanAddress} but the internet sees ${found.address}: carrier-grade NAT or another NAT layer.`
          )
        } else {
          externalCheck = 'confirmed'
          warnings.push(`The internet sees ${found.address}. A port still needs forwarding.`)
        }
        const seed = parseSeed(options.seedUrl)
        if (seed) {
          const scheme: 'http' | 'https' = seed.protocol === 'https:' ? 'https' : 'http'
          const url = buildUrl(scheme, found.address, seedPort(seed), seed)
          if (!candidates.some((candidate) => candidate.url === url)) {
            candidates.push({
              kind: 'public-v4',
              url,
              family: 'ipv4',
              confidence: 'unverified',
              source: 'external',
              note: 'External address confirmed; requires a port forward'
            })
          }
        }
      }
    } catch (error) {
      externalCheck = 'error'
      warnings.push(
        `Public address check failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return {
    seed: options.seedUrl,
    candidates,
    gateway,
    externalCheck,
    ...(externalAddress ? { externalAddress } : {}),
    ...(externalProvider ? { externalProvider } : {}),
    warnings: [...warnings, ...gatewayWarnings(gateway)]
  }
}
