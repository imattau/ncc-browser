import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import type { UpnpGateway } from '../src/main/hosting/discover'
import {
  PortMappingError,
  PortMappingService,
  lanAddress
} from '../src/main/hosting/port-mapping'

const GATEWAY: UpnpGateway = {
  serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
  controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
  externalAddress: '203.0.113.42'
}

function info(address: string, family: NetworkInterfaceInfo['family'], internal = false): NetworkInterfaceInfo {
  const base = {
    address,
    netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
    family,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`
  }
  return (family === 'IPv6' ? { ...base, scopeid: 0 } : base) as NetworkInterfaceInfo
}

function setup(
  options: {
    gateway?: UpnpGateway | null
    external?: string
    natPmpExternal?: string
    natPmpGranted?: number
    defaultGateway?: string | null
  } = {}
) {
  const file = join(mkdtempSync(join(tmpdir(), 'ncc-port-map-')), 'port-mappings.json')
  const addMapping = vi.fn(async () => undefined)
  const deleteMapping = vi.fn(async () => undefined)
  const natPmpMap = vi.fn(async () => options.natPmpGranted ?? 8080)
  const natPmpDelete = vi.fn(async () => 1)
  const service = new PortMappingService({
    filePath: file,
    now: () => 1_800_000_000,
    findGateway: async () => (options.gateway === undefined ? GATEWAY : options.gateway),
    externalAddress: async () => options.external ?? GATEWAY.externalAddress ?? null,
    addMapping,
    deleteMapping,
    defaultGateway: () => (options.defaultGateway === undefined ? '192.168.1.1' : options.defaultGateway),
    natPmpExternal: async () => options.natPmpExternal ?? '198.51.100.7',
    natPmpMap,
    natPmpDelete,
    interfaces: () => ({
      lo: [info('127.0.0.1', 'IPv4', true)],
      eth0: [info('192.168.1.20', 'IPv4')]
    })
  })
  return { service, addMapping, deleteMapping, natPmpMap, natPmpDelete, file }
}

describe('LAN address selection', () => {
  it('picks a private IPv4 and skips loopback', () => {
    expect(
      lanAddress({
        lo: [info('127.0.0.1', 'IPv4', true)],
        docker0: [info('172.17.0.1', 'IPv4')],
        wlan0: [info('192.168.1.20', 'IPv4')]
      })
    ).toBe('172.17.0.1')
    expect(lanAddress({ lo: [info('127.0.0.1', 'IPv4', true)] })).toBeNull()
  })
})

describe('PortMappingService', () => {
  it('maps a TCP port, persists it and reuses the record', async () => {
    const { service, addMapping, file } = setup()
    const mapping = await service.map({ localPort: 8080 })

    expect(addMapping).toHaveBeenCalledWith(GATEWAY, {
      externalPort: 8080,
      internalPort: 8080,
      internalClient: '192.168.1.20',
      protocol: 'TCP',
      description: 'Nostr Navigator',
      leaseSeconds: 7200
    })
    expect(mapping).toMatchObject({
      localPort: 8080,
      externalPort: 8080,
      method: 'upnp',
      externalAddress: '203.0.113.42',
      internalClient: '192.168.1.20',
      url: 'http://203.0.113.42:8080/',
      createdAt: 1_800_000_000
    })

    const again = await service.map({ localPort: 8080 })
    expect(again).toEqual(mapping)
    expect(addMapping).toHaveBeenCalledOnce()

    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored.mappings).toHaveLength(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the scheme and can use a different external port', async () => {
    const { service } = setup()
    const mapping = await service.map({ localPort: 8443, externalPort: 443, secure: true })
    expect(mapping.url).toBe('https://203.0.113.42:443/')
    expect(mapping.externalPort).toBe(443)
  })

  it('refuses a mapping when the WAN address is not public', async () => {
    const { service } = setup({
      gateway: { ...GATEWAY, externalAddress: undefined },
      external: '100.64.3.7'
    })
    await expect(service.map({ localPort: 8080 })).rejects.toBeInstanceOf(PortMappingError)
    await expect(service.map({ localPort: 8080 })).rejects.toThrow(/not public/i)
  })

  it('refuses when neither UPnP nor NAT-PMP answers', async () => {
    const { service } = setup({ gateway: null, defaultGateway: null })
    await expect(service.map({ localPort: 8080 })).rejects.toThrow(/No UPnP or NAT-PMP/)
  })

  it('falls back to NAT-PMP when UPnP does not answer', async () => {
    const { service, natPmpMap, natPmpDelete, addMapping } = setup({
      gateway: null,
      natPmpGranted: 18080,
      natPmpExternal: '198.51.100.7'
    })
    const mapping = await service.map({ localPort: 8080, secure: true })
    expect(addMapping).not.toHaveBeenCalled()
    expect(natPmpMap).toHaveBeenCalledWith('192.168.1.1', {
      internalPort: 8080,
      externalPort: 8080,
      protocol: 'TCP',
      lifetimeSeconds: 7200
    })
    expect(mapping).toMatchObject({
      method: 'natpmp',
      externalPort: 18080,
      externalAddress: '198.51.100.7',
      url: 'https://198.51.100.7:18080/'
    })

    await service.remove(8080)
    expect(natPmpDelete).toHaveBeenCalledWith('192.168.1.1', 18080)
  })

  it('marks and clears an external verification', async () => {
    const { service } = setup()
    await service.map({ localPort: 8080 })
    expect(service.markVerified(8080, 1_800_000_100)?.verifiedAt).toBe(1_800_000_100)
    expect(service.markVerified(8080, null)?.verifiedAt).toBeUndefined()
    expect(service.markVerified(9999, 1)).toBeNull()
  })

  it('validates ports and reports router failures', async () => {
    const { service, addMapping } = setup()
    await expect(service.map({ localPort: 0 })).rejects.toThrow(/1 and 65535/)
    addMapping.mockRejectedValueOnce(new Error('718 ConflictInMappingEntry'))
    await expect(service.map({ localPort: 8080 })).rejects.toThrow(/ConflictInMappingEntry/)
  })

  it('removes one mapping and all mappings', async () => {
    const { service, deleteMapping, file } = setup()
    await service.map({ localPort: 8080 })
    await service.map({ localPort: 9090 })
    await service.remove(8080)
    expect(deleteMapping).toHaveBeenCalledWith(GATEWAY, 8080, 'TCP')
    expect(service.list()).toHaveLength(1)

    await service.removeAll()
    expect(deleteMapping).toHaveBeenCalledWith(GATEWAY, 9090, 'TCP')
    expect(service.list()).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).mappings).toEqual([])
  })
})
