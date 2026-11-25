/**
 * Works out, without asking the user for ports or schemes, which plain HTTP server a
 * hosted service points at, and puts the browser's HTTPS front in front of it.
 */

import { connect as connectTcp, isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { connect as connectTls } from 'node:tls'
import {
  endpointPort,
  isLoopbackHost,
  isTlsProxyEndpoint,
  type EndpointHostKind,
  type HostedService,
  type ServiceEndpoint
} from '@shared/hosting'
import { isLinkLocalIPv6, isPrivateIPv4, isUniqueLocalIPv6 } from '../net/ip-class'
import type { TlsProxyManager } from './tls-proxy'

export type ServerProtocol = 'tls' | 'http' | 'none'
export type ProtocolProbe = (host: string, port: number) => Promise<ServerProtocol>

export function localAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): Set<string> {
  return new Set(
    Object.values(interfaces).flatMap((entries) =>
      (entries ?? []).map((entry) => entry.address.split('%')[0].toLowerCase())
    )
  )
}

export function hostKind(host: string, own: ReadonlySet<string> = localAddresses()): EndpointHostKind {
  if (isLoopbackHost(host) || own.has(host)) return 'local'
  if (isIP(host) === 4) {
    return isPrivateIPv4(host) || host.startsWith('169.254.') ? 'private' : 'public'
  }
  if (isIP(host) === 6) {
    return isUniqueLocalIPv6(host) || isLinkLocalIPv6(host) ? 'private' : 'public'
  }
  return host.endsWith('.local') ? 'private' : 'public'
}

function speaksTls(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Only the handshake matters here; nothing is sent over this connection.
    const socket = connectTls({ host, port, rejectUnauthorized: false })
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('secureConnect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function speaksHttp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host, port }, () => {
      socket.write('HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n')
    })
    let received = ''
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (received.length >= 5) done(received.startsWith('HTTP/'))
    })
    socket.once('end', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** TLS is tried first: some HTTPS servers also answer plain requests with an error. */
export async function probeProtocol(
  host: string,
  port: number,
  timeoutMs = 3000
): Promise<ServerProtocol> {
  if (await speaksTls(host, port, timeoutMs)) return 'tls'
  return (await speaksHttp(host, port, timeoutMs)) ? 'http' : 'none'
}

function parts(endpoint: ServiceEndpoint): { host: string; port: number; secure: boolean } {
  const url = new URL(endpoint.url)
  return {
    host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    port: endpointPort(url),
    secure: url.protocol === 'https:'
  }
}

/** Saved endpoints that could be served by a program on this machine. */
function reachingThisMachine(
  endpoints: readonly ServiceEndpoint[],
  own: ReadonlySet<string>
): Array<ReturnType<typeof parts> & { kind: EndpointHostKind }> {
  return endpoints
    .filter((endpoint) => !isTlsProxyEndpoint(endpoint))
    .map(parts)
    .filter((entry) => !entry.host.endsWith('.onion'))
    .map((entry) => ({ ...entry, kind: hostKind(entry.host, own) }))
    .filter((entry) => entry.kind !== 'private')
}

/**
 * The plain HTTP server on this machine behind one of the ports. This machine's LAN
 * address is preferred to loopback, so the server is less likely to treat forwarded
 * visitors as local.
 */
export async function findHttpServer(
  endpoints: readonly ServiceEndpoint[],
  own: ReadonlySet<string> = localAddresses(),
  probe: ProtocolProbe = probeProtocol
): Promise<{ host: string; port: number } | null> {
  const candidates = reachingThisMachine(endpoints, own)
  for (const port of new Set(candidates.map((entry) => entry.port))) {
    const named = candidates
      .filter((entry) => entry.port === port && entry.kind === 'local' && !isLoopbackHost(entry.host))
      .map((entry) => entry.host)
    for (const host of new Set([...named, '127.0.0.1', '::1'])) {
      if ((await probe(host, port)) === 'http') return { host, port }
    }
  }
  return null
}

/** True when a saved `https://` endpoint turns out to be a plain HTTP server. */
export async function hasBrokenHttpsEndpoint(
  endpoints: readonly ServiceEndpoint[],
  own: ReadonlySet<string> = localAddresses(),
  probe: ProtocolProbe = probeProtocol
): Promise<boolean> {
  for (const entry of reachingThisMachine(endpoints, own)) {
    if (entry.secure && (await probe(entry.host, entry.port)) === 'http') return true
  }
  return false
}

function targetUrl(server: { host: string; port: number }): string {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host
  return `http://${host}:${server.port}`
}

export class HttpsSetup {
  constructor(
    private readonly proxies: TlsProxyManager,
    private readonly probe: ProtocolProbe = probeProtocol,
    private readonly addresses: () => Set<string> = () => localAddresses()
  ) {}

  /** Turn HTTPS on for a service, finding its server from the saved endpoints. */
  async enable(service: HostedService): Promise<void> {
    const server = await findHttpServer(service.endpoints, this.addresses(), this.probe)
    if (!server) {
      throw new Error(
        'No plain HTTP server answered on this machine at this service’s ports. Start the server, check the port in the endpoint, then try again. A server that already uses HTTPS does not need this.'
      )
    }
    await this.proxies.ensure(service.id, { url: targetUrl(server) })
  }

  /**
   * Run before publishing or sharing. Keeps an enabled HTTPS front running and
   * pointed at the service's current port, and turns it on when a saved `https://`
   * address would otherwise fail because the server only speaks plain HTTP.
   */
  async prepare(service: HostedService): Promise<void> {
    const record = this.proxies.record(service.id)
    if (!record) {
      if (await hasBrokenHttpsEndpoint(service.endpoints, this.addresses(), this.probe)) {
        await this.enable(service)
      }
      return
    }
    const samePort = reachingThisMachine(service.endpoints, this.addresses()).some(
      (entry) => entry.port === record.targetPort
    )
    if (!samePort) {
      await this.enable(service)
    } else if (!this.proxies.isRunning(service.id)) {
      const target = { host: record.targetHost, port: record.targetPort }
      await this.proxies.ensure(service.id, { url: targetUrl(target) })
    }
  }
}
