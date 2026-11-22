import { describe, expect, it, vi } from 'vitest'
import type { PortMapping } from '../src/shared/reachability'
import { PortMonitor } from '../src/main/hosting/port-monitor'

function mapping(overrides: Partial<PortMapping> = {}): PortMapping {
  return {
    localPort: 8080,
    externalPort: 8080,
    protocol: 'TCP',
    method: 'upnp',
    internalClient: '192.168.1.20',
    externalAddress: '203.0.113.42',
    url: 'http://203.0.113.42:8080/',
    createdAt: 1_800_000_000,
    ...overrides
  }
}

function setup(
  options: {
    ready?: boolean
    mappings?: PortMapping[]
    probe?: (host: string, port: number, proxy: string | null, timeoutMs?: number) => Promise<boolean>
  } = {}
) {
  const current = new Map((options.mappings ?? [mapping()]).map((entry) => [entry.localPort, { ...entry }]))
  const reportCheck = vi.fn((localPort: number, ok: boolean, at: number) => {
    const entry = current.get(localPort)
    if (!entry) return null
    entry.lastCheckedAt = at
    if (ok) {
      entry.verifiedAt = at
      entry.failures = 0
    } else {
      entry.failures = (entry.failures ?? 0) + 1
    }
    return { ...entry }
  })
  const onChange = vi.fn()
  const monitor = new PortMonitor({
    mappings: {
      list: () => [...current.values()].map((entry) => ({ ...entry })),
      reportCheck
    },
    tor: { status: () => ({ ready: options.ready !== false, proxy: 'socks5://127.0.0.1:9050' }) },
    ...(options.probe ? { probe: options.probe } : {}),
    now: () => 1_800_000_000,
    failureThreshold: 2,
    onChange
  })
  return { monitor, reportCheck, onChange, current }
}

describe('PortMonitor', () => {
  it('raises one alert after two failures and clears it on recovery', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { monitor, onChange } = setup({ probe })

    expect(await monitor.check()).toEqual([])
    const failing = await monitor.check()
    expect(failing).toHaveLength(1)
    expect(failing[0]).toMatchObject({ state: 'failing' })
    expect(failing[0].mapping.failures).toBe(2)
    expect(onChange).toHaveBeenCalledOnce()
    expect(monitor.stateFor(8080)).toBe('failing')

    const recovered = await monitor.check()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ state: 'ok' })
    expect(recovered[0].mapping.verifiedAt).toBe(1_800_000_000)
    expect(monitor.stateFor(8080)).toBe('ok')
  })

  it('does nothing while Tor is not running', async () => {
    const { monitor, reportCheck } = setup({ ready: false })
    expect(await monitor.check()).toEqual([])
    expect(reportCheck).not.toHaveBeenCalled()
  })

  it('does nothing without mappings', async () => {
    const { monitor } = setup({ mappings: [] })
    expect(await monitor.check()).toEqual([])
  })

  it('treats a probe error as a failure', async () => {
    const { monitor, reportCheck } = setup({
      probe: async () => {
        throw new Error('timeout')
      }
    })
    await monitor.check()
    await monitor.check()
    expect(reportCheck).toHaveBeenLastCalledWith(8080, false, 1_800_000_000)
  })
})
