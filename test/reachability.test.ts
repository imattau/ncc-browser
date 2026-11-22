import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import {
  classifyWanAddress,
  discoverReachability,
  gatewayWarnings,
  interfaceCandidates,
  isCgnatIPv4,
  isGlobalIPv6,
  isPrivateIPv4
} from '../src/main/hosting/discover'

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
    cidr: family === 'IPv4' ? `${address}/24` : `${address}/64`
  }
  return (family === 'IPv6' ? { ...base, scopeid: 0 } : base) as NetworkInterfaceInfo
}

describe('address classification', () => {
  it('separates private, CGNAT and public IPv4', () => {
    expect(isPrivateIPv4('192.168.1.20')).toBe(true)
    expect(isPrivateIPv4('10.0.0.5')).toBe(true)
    expect(isPrivateIPv4('172.20.0.1')).toBe(true)
    expect(isPrivateIPv4('8.8.8.8')).toBe(false)
    expect(isCgnatIPv4('100.64.3.7')).toBe(true)
    expect(isCgnatIPv4('100.128.0.1')).toBe(false)
    expect(isCgnatIPv4('8.8.8.8')).toBe(false)
  })

  it('classifies router WAN addresses', () => {
    expect(classifyWanAddress('100.64.3.7')).toBe('cgnat')
    expect(classifyWanAddress('192.168.1.1')).toBe('private')
    expect(classifyWanAddress('203.0.113.42')).toBe('public')
    expect(classifyWanAddress('127.0.0.1')).toBe('loopback')
    expect(classifyWanAddress('169.254.1.1')).toBe('link-local')
    expect(classifyWanAddress('0.0.0.0')).toBe('unknown')
    expect(classifyWanAddress(undefined)).toBe('unknown')
    expect(classifyWanAddress('fd00::1')).toBe('private')
    expect(classifyWanAddress('2001:db8::1')).toBe('public')
  })

  it('accepts only global unicast IPv6', () => {
    expect(isGlobalIPv6('2001:db8::1')).toBe(true)
    expect(isGlobalIPv6('2a00:1450::1')).toBe(true)
    expect(isGlobalIPv6('fd00::1')).toBe(false)
    expect(isGlobalIPv6('fe80::1')).toBe(false)
    expect(isGlobalIPv6('::1')).toBe(false)
  })

  it('warns when the router reports CGNAT', () => {
    const warnings = gatewayWarnings({
      wanAddress: '100.64.3.7',
      wanClass: 'cgnat',
      upnp: true,
      natPmp: false,
      pcp: false,
      mappingAvailable: true
    })
    expect(warnings.join(' ')).toMatch(/carrier-grade NAT/i)
  })
})

describe('interface candidates', () => {
  const interfaces = {
    lo: [info('127.0.0.1', 'IPv4', true)],
    eth0: [info('192.168.1.20', 'IPv4'), info('2001:db8::20', 'IPv6')],
    docker0: [info('172.17.0.1', 'IPv4')]
  }

  it('lists loopback, LAN and global IPv6 for a local page', () => {
    const { candidates } = interfaceCandidates('http://127.0.0.1:8080/app', interfaces)
    const urls = candidates.map((candidate) => candidate.url)
    expect(urls).toContain('http://127.0.0.1:8080/app')
    expect(urls).toContain('http://localhost:8080/app')
    expect(urls).toContain('http://192.168.1.20:8080/app')
    expect(urls).toContain('http://[2001:db8::20]:8080/app')
    expect(urls).toContain('http://172.17.0.1:8080/app')

    expect(candidates.find((candidate) => candidate.url.includes('127.0.0.1'))?.confidence).toBe(
      'owner-only'
    )
    expect(candidates.find((candidate) => candidate.url.includes('192.168.1.20'))?.confidence).toBe(
      'same-network'
    )
    expect(candidates.find((candidate) => candidate.url.includes('2001:db8'))?.confidence).toBe(
      'firewall-dependent'
    )
    expect(candidates.find((candidate) => candidate.url.includes('2001:db8'))?.family).toBe('ipv6')
  })

  it('keeps the page scheme and path', () => {
    const { candidates } = interfaceCandidates('https://192.168.1.20:8443/admin?x=1', interfaces)
    const lan = candidates.find((candidate) => candidate.kind === 'lan' && candidate.url.includes('192.168.1.20'))
    expect(lan?.url).toBe('https://192.168.1.20:8443/admin?x=1')
    expect(candidates.some((candidate) => candidate.url.startsWith('https://127.0.0.1:8443'))).toBe(true)
  })

  it('treats a remote page as already reachable', () => {
    const { candidates, warnings } = interfaceCandidates('https://photos.example', {
      eth0: [info('192.168.1.20', 'IPv4')]
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      kind: 'current-https',
      url: 'https://photos.example:443/',
      confidence: 'verified'
    })
    expect(warnings.join(' ')).toMatch(/remote address/i)
  })

  it('does not offer a plain public address as verified', () => {
    const { candidates } = interfaceCandidates('http://203.0.113.42:9000', {})
    expect(candidates[0]).toMatchObject({ kind: 'public-v4', confidence: 'unverified' })
  })

  it('warns when only loopback is available', () => {
    const { candidates, warnings } = interfaceCandidates('http://127.0.0.1:5173', {})
    expect(candidates.every((candidate) => candidate.kind === 'loopback')).toBe(true)
    expect(warnings.join(' ')).toMatch(/tunnel or Tor/i)
  })

  it('handles onion pages and non-http seeds', () => {
    const onion = interfaceCandidates('http://exampleexampleexample.onion:8080', {})
    expect(onion.candidates[0]).toMatchObject({ kind: 'onion', family: 'onion' })

    const ncc = interfaceCandidates('ncc://npub1abc/photos', {})
    expect(ncc.candidates).toHaveLength(0)
    expect(ncc.warnings.join(' ')).toMatch(/http\(s\) endpoint/i)
  })

  it('skips link-local interface addresses', () => {
    const { candidates, warnings } = interfaceCandidates('http://127.0.0.1:8080', {
      eth1: [info('169.254.10.5', 'IPv4')]
    })
    expect(candidates.some((candidate) => candidate.url.includes('169.254'))).toBe(false)
    expect(warnings.join(' ')).toMatch(/link-local/i)
  })
})

describe('discoverReachability', () => {
  it('adds a confirmed public candidate from an opt-in lookup', async () => {
    const report = await discoverReachability({
      seedUrl: 'http://127.0.0.1:8080',
      gateway: false,
      interfaces: { eth0: [info('192.168.1.20', 'IPv4')] },
      external: true,
      lookupPublicAddress: async () => ({
        address: '203.0.113.42',
        family: 'ipv4',
        provider: 'https://api64.ipify.org?format=json',
        checkedAt: 1
      })
    })
    expect(report.externalCheck).toBe('confirmed')
    expect(report.externalAddress).toBe('203.0.113.42')
    expect(report.externalProvider).toContain('api64.ipify.org')
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        kind: 'public-v4',
        url: 'http://203.0.113.42:8080/',
        source: 'external',
        confidence: 'unverified'
      })
    )
    expect(report.warnings.join(' ')).toMatch(/port still needs forwarding/i)
  })

  it('reports a failed external lookup without failing discovery', async () => {
    const report = await discoverReachability({
      seedUrl: 'http://127.0.0.1:8080',
      gateway: false,
      external: true,
      lookupPublicAddress: async () => {
        throw new Error('provider down')
      }
    })
    expect(report.externalCheck).toBe('error')
    expect(report.warnings.join(' ')).toMatch(/provider down/)
    expect(report.candidates.some((candidate) => candidate.kind === 'loopback')).toBe(true)
  })

  it('does not invent an inbound candidate from an IPv6 egress', async () => {
    const report = await discoverReachability({
      seedUrl: 'http://127.0.0.1:8080',
      gateway: false,
      external: true,
      lookupPublicAddress: async () => ({
        address: '2001:db8::99',
        family: 'ipv6',
        provider: 'p',
        checkedAt: 1
      })
    })
    expect(report.externalCheck).toBe('confirmed')
    expect(report.candidates.some((candidate) => candidate.url.includes('2001:db8::99'))).toBe(false)
    expect(report.warnings.join(' ')).toMatch(/Inbound IPv6 uses the host/i)
  })

  it('skips the gateway when asked and reports no external check', async () => {
    const report = await discoverReachability({
      seedUrl: 'http://127.0.0.1:8080',
      gateway: false,
      interfaces: { eth0: [info('192.168.1.20', 'IPv4')] }
    })
    expect(report.externalCheck).toBe('not-run')
    expect(report.gateway.wanClass).toBe('unknown')
    expect(report.candidates.some((candidate) => candidate.url.includes('192.168.1.20'))).toBe(true)
    expect(report.warnings.join(' ')).toMatch(/gateway check skipped/i)
  })
})
