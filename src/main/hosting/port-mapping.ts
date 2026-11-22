/**
 * Explicit UPnP port mappings for a local service.
 *
 * A mapping is created only when the publisher clicks the action. It is TCP-only,
 * scoped to one port, described as Nostr Navigator and given a two-hour lease, so a
 * crash cannot leave a permanent hole. Removing a mapping, or quitting, deletes it.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { dirname } from 'node:path'
import type { PortMapping } from '@shared/reachability'
import {
  addUpnpPortMapping,
  classifyWanAddress,
  deleteUpnpPortMapping,
  findUpnpGateway,
  upnpExternalAddressOn,
  type UpnpGateway
} from './discover'

interface MappingFile {
  version: 1
  mappings: PortMapping[]
}

export interface PortMappingOptions {
  filePath: string
  now?: () => number
  findGateway?: (timeoutMs: number) => Promise<UpnpGateway | null>
  externalAddress?: (gateway: UpnpGateway) => Promise<string | null>
  addMapping?: typeof addUpnpPortMapping
  deleteMapping?: typeof deleteUpnpPortMapping
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  log?: (line: string) => void
}

export class PortMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortMappingError'
  }
}

export interface MapPortInput {
  localPort: number
  secure?: boolean
  externalPort?: number
  description?: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function load(path: string): PortMapping[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MappingFile>
    return Array.isArray(parsed.mappings) ? parsed.mappings : []
  } catch {
    return []
  }
}

/** The first private IPv4 interface, which is what a router can forward to. */
export function lanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): string | null {
  for (const addresses of Object.values(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.internal || info.family !== 'IPv4') continue
      const address = info.address
      if (classifyWanAddress(address) === 'private') return address
    }
  }
  return null
}

export class PortMappingService {
  private readonly now: () => number
  private mappings: PortMapping[]
  private readonly findGateway: (timeoutMs: number) => Promise<UpnpGateway | null>
  private readonly externalAddress: (gateway: UpnpGateway) => Promise<string | null>
  private readonly addMapping: typeof addUpnpPortMapping
  private readonly deleteMapping: typeof deleteUpnpPortMapping
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>

  constructor(private readonly options: PortMappingOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.findGateway = options.findGateway ?? findUpnpGateway
    this.externalAddress = options.externalAddress ?? ((gateway) => upnpExternalAddressOn(gateway))
    this.addMapping = options.addMapping ?? addUpnpPortMapping
    this.deleteMapping = options.deleteMapping ?? deleteUpnpPortMapping
    this.interfaces = options.interfaces ?? networkInterfaces
    this.mappings = load(options.filePath)
  }

  list(): PortMapping[] {
    return this.mappings.map(clone)
  }

  find(localPort: number): PortMapping | null {
    const record = this.mappings.find((entry) => entry.localPort === localPort)
    return record ? clone(record) : null
  }

  async map(input: MapPortInput): Promise<PortMapping> {
    const localPort = validatePort(input.localPort)
    const existing = this.mappings.find((entry) => entry.localPort === localPort)
    if (existing) return clone(existing)

    const internalClient = lanAddress(this.interfaces())
    if (!internalClient) {
      throw new PortMappingError('No private IPv4 interface is available to forward to')
    }
    const gateway = await this.findGateway(4000)
    if (!gateway) {
      throw new PortMappingError(
        'No UPnP router answered. Forward the port manually, or use a Tor onion endpoint.'
      )
    }
    const externalAddress = gateway.externalAddress ?? (await this.externalAddress(gateway))
    if (!externalAddress) {
      throw new PortMappingError('The router did not report a public WAN address')
    }
    if (classifyWanAddress(externalAddress) !== 'public') {
      throw new PortMappingError(
        `The router WAN address ${externalAddress} is not public; a port mapping cannot make it reachable.`
      )
    }

    const externalPort = validatePort(input.externalPort ?? localPort)
    try {
      await this.addMapping(gateway, {
        externalPort,
        internalPort: localPort,
        internalClient,
        protocol: 'TCP',
        description: input.description?.slice(0, 64) ?? 'Nostr Navigator',
        leaseSeconds: 7200
      })
    } catch (error) {
      throw new PortMappingError(
        `The router refused the port mapping: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const mapping: PortMapping = {
      localPort,
      externalPort,
      protocol: 'TCP',
      internalClient,
      externalAddress,
      url: `${input.secure ? 'https' : 'http'}://${formatHost(externalAddress)}:${externalPort}/`,
      ...(input.description ? { description: input.description.slice(0, 64) } : {}),
      createdAt: this.now()
    }
    this.mappings = [...this.mappings.filter((entry) => entry.localPort !== localPort), mapping]
    this.flush()
    this.options.log?.(`mapped TCP ${externalPort} -> ${internalClient}:${localPort}`)
    return clone(mapping)
  }

  async remove(localPort: number): Promise<void> {
    const mapping = this.mappings.find((entry) => entry.localPort === localPort)
    if (!mapping) return
    try {
      const gateway = await this.findGateway(4000)
      if (gateway) {
        await this.deleteMapping(gateway, mapping.externalPort, 'TCP')
      }
    } catch {
      // The lease expires even if the router is unreachable now.
    }
    this.mappings = this.mappings.filter((entry) => entry.localPort !== localPort)
    this.flush()
  }

  async removeAll(): Promise<void> {
    for (const mapping of [...this.mappings]) {
      await this.remove(mapping.localPort)
    }
  }

  private flush(): void {
    const payload: MappingFile = { version: 1, mappings: this.mappings }
    const path = this.options.filePath
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
    chmodSync(path, 0o600)
  }
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new PortMappingError('Enter a port between 1 and 65535')
  }
  return value
}

function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}
