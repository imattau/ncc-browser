import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { NetworkInterfaceInfo } from 'node:os'
import type { GatewayReport } from '@shared/reachability'
import { classifyWanAddress, ipv4ToInt } from './ip-class'
import { natPmpExternalAddress } from './nat-pmp'
import { upnpExternalAddress } from './upnp'

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

export function emptyGateway(error?: string, upnp = false): GatewayReport {
  return {
    wanClass: 'unknown',
    upnp,
    natPmp: false,
    pcp: false,
    mappingAvailable: false,
    ...(error ? { error } : {})
  }
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
