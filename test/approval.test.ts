import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalBroker } from '../src/main/approval'
import type { SignerRequest } from '../src/shared/types'

const REQUEST: Omit<SignerRequest, 'id'> = {
  method: 'signEvent',
  action: 'sign a kind 1 event',
  service: 'ncc://npub1test/web',
  origin: 'ncc://npub1test/web',
  identity: 'npub1test',
  mode: 'local',
  event: { kind: 1, created_at: 1_800_000_000, tags: [], content: 'hello' },
  rememberable: true
}

function broker(timeoutMs = 120_000) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const overlays: boolean[] = []
  const instance = new ApprovalBroker({
    send: (channel, payload) => {
      sent.push({ channel, payload })
      return true
    },
    setOverlay: (visible) => overlays.push(visible),
    timeoutMs
  })
  return { instance, sent, overlays }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ApprovalBroker', () => {
  it('sends the request, shows the overlay, and resolves on respond', async () => {
    const { instance, sent, overlays } = broker()
    const decision = instance.request(REQUEST)

    const request = sent[0]
    expect(request.channel).toBe('ncc:signer-request')
    expect((request.payload as { service: string }).service).toBe('ncc://npub1test/web')
    expect(typeof (request.payload as { id: string }).id).toBe('string')
    expect(overlays).toEqual([true])

    instance.respond((request.payload as { id: string }).id, { allow: true, remember: true })
    await expect(decision).resolves.toEqual({ allow: true, remember: true })
    expect(sent.some((entry) => entry.channel === 'ncc:signer-resolved')).toBe(true)
    expect(overlays).toEqual([true, false])
  })

  it('denies after the timeout', async () => {
    vi.useFakeTimers()
    const { instance, overlays } = broker(5_000)
    const decision = instance.request(REQUEST)

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(decision).resolves.toEqual({ allow: false, remember: false })
    expect(overlays).toEqual([true, false])
  })

  it('cancels every pending request when the window closes', async () => {
    const { instance, overlays } = broker()
    const first = instance.request(REQUEST)
    const second = instance.request({ ...REQUEST, method: 'getPublicKey' })
    expect(instance.pendingCount).toBe(2)

    instance.cancelAll()
    await expect(first).resolves.toEqual({ allow: false, remember: false })
    await expect(second).resolves.toEqual({ allow: false, remember: false })
    expect(instance.pendingCount).toBe(0)
    expect(overlays).toEqual([true, false])
  })

  it('keeps the overlay while another request is pending', async () => {
    const { instance, sent, overlays } = broker()
    const first = instance.request(REQUEST)
    const second = instance.request({ ...REQUEST, method: 'getPublicKey' })

    const ids = sent
      .filter((entry) => entry.channel === 'ncc:signer-request')
      .map((entry) => (entry.payload as { id: string }).id)

    instance.respond(ids[0], { allow: true, remember: false })
    await expect(first).resolves.toEqual({ allow: true, remember: false })
    expect(overlays).toEqual([true])

    instance.respond(ids[1], { allow: false, remember: false })
    await expect(second).resolves.toEqual({ allow: false, remember: false })
    expect(overlays).toEqual([true, false])
  })

  it('denies immediately when the renderer is unavailable', async () => {
    const overlays: boolean[] = []
    const instance = new ApprovalBroker({
      send: () => false,
      setOverlay: (visible) => overlays.push(visible)
    })
    await expect(instance.request(REQUEST)).resolves.toEqual({ allow: false, remember: false })
    expect(overlays).toEqual([true, false])
  })
})
