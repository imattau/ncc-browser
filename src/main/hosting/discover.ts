/**
 * Endpoint discovery for hosted services.
 *
 * Nothing here changes the `ncc://` address: discovery only proposes endpoint
 * candidates the publisher may advertise. Only local information is used:
 * the current page URL, the host's network interfaces and the local gateway.
 * Contacting an external address service is a later, explicit opt-in.
 */

import type { NetworkInterfaceInfo } from 'node:os'
import type {
  ExternalCheckState,
  GatewayReport,
  ReachabilityReport
} from '@shared/reachability'
import type { PublicAddress } from './public-address'
import { buildUrl, parseSeed, seedPort } from '../net/endpoint'
import { emptyGateway, gatewayWarnings, queryGateway } from '../net/gateway'
import { interfaceCandidates } from '../net/interfaces'

// The discovery helpers moved into `src/main/net/`; keep this module's public
// surface for callers and tests that treat discovery as one feature.
export { classifyWanAddress, isCgnatIPv4, isGlobalIPv6, isPrivateIPv4 } from '../net/ip-class'
export { interfaceCandidates, type InterfaceCandidateOptions } from '../net/interfaces'
export { gatewayWarnings, queryGateway } from '../net/gateway'
export { encodeNatPmpMap, parseNatPmpMapResponse, type NatPmpMapRequest } from '../net/nat-pmp'
export type { UpnpGateway } from '../net/upnp'

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
