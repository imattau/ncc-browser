import { describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { NetworkWatch } from '../src/main/hosting/network-watch'

function info(
  address: string,
  family: NetworkInterfaceInfo['family'],
  internal = false
): NetworkInterfaceInfo {
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

describe('NetworkWatch', () => {
  it('reports an address change on the same interface', () => {
    let nets = { eth0: [info('192.168.1.20', 'IPv4')] }
    const onChange = vi.fn()
    const watch = new NetworkWatch({ interfaces: () => nets, now: () => 100, onChange })
    expect(watch.tick()).toEqual([])

    nets = { eth0: [info('192.168.1.99', 'IPv4')] }
    expect(watch.tick()).toEqual([
      { at: 100, interface: 'eth0', family: 'ipv4', from: '192.168.1.20', to: '192.168.1.99' }
    ])
    expect(onChange).toHaveBeenCalledOnce()
    expect(watch.list()).toHaveLength(1)

    expect(watch.tick()).toEqual([])
    expect(watch.list()).toHaveLength(1)
  })

  it('tracks an IPv6 prefix change and ignores local-only addresses', () => {
    let nets = {
      lo: [info('127.0.0.1', 'IPv4', true)],
      eth0: [info('2001:db8:1::20', 'IPv6'), info('169.254.10.5', 'IPv4')],
      wlan0: [info('fd00::1', 'IPv6')]
    }
    const watch = new NetworkWatch({ interfaces: () => nets, now: () => 200 })
    watch.tick()
    nets = {
      lo: [info('127.0.0.1', 'IPv4', true)],
      eth0: [info('2001:db8:2::20', 'IPv6'), info('169.254.10.5', 'IPv4')],
      wlan0: [info('fd00::1', 'IPv6')]
    }
    expect(watch.tick()).toEqual([
      {
        at: 200,
        interface: 'eth0',
        family: 'ipv6',
        from: '2001:db8:1::20',
        to: '2001:db8:2::20'
      }
    ])
  })

  it('does not report an added address as a change', () => {
    let nets = { eth0: [info('192.168.1.20', 'IPv4')] }
    const watch = new NetworkWatch({ interfaces: () => nets })
    watch.tick()
    nets = { eth0: [info('192.168.1.20', 'IPv4'), info('192.168.1.21', 'IPv4')] }
    expect(watch.tick()).toEqual([])
  })
})
