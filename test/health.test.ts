import { describe, expect, it } from 'vitest'
import { EndpointHealth, orderByHealth } from '../src/main/ncc/health'

describe('EndpointHealth', () => {
  it('cools down after a failure with exponential backoff', () => {
    const health = new EndpointHealth(1_000, 8_000)
    const url = 'http://1.2.3.4:80/'
    const now = 10_000

    expect(health.isCoolingDown(url, now)).toBe(false)
    expect(health.recordFailure(url, now)).toBe(1_000)
    expect(health.isCoolingDown(url, now + 999)).toBe(true)
    expect(health.isCoolingDown(url, now + 1_000)).toBe(false)

    expect(health.recordFailure(url, now + 1_000)).toBe(2_000)
    expect(health.recordFailure(url, now + 2_000)).toBe(4_000)
    expect(health.recordFailure(url, now + 3_000)).toBe(8_000)
    expect(health.recordFailure(url, now + 4_000)).toBe(8_000)
  })

  it('forgets failures after a success', () => {
    const health = new EndpointHealth(1_000, 8_000)
    health.recordFailure('http://a/')
    health.recordSuccess('http://a/')
    expect(health.get('http://a/')).toBeUndefined()
    expect(health.isCoolingDown('http://a/')).toBe(false)
  })

  it('keeps a single-endpoint locator usable while cooling down', () => {
    const health = new EndpointHealth(60_000, 60_000)
    const endpoints = [{ url: 'http://only/' }]
    health.recordFailure('http://only/')
    expect(orderByHealth(endpoints, health)).toEqual(endpoints)
  })

  it('prefers endpoints that are not cooling down', () => {
    const health = new EndpointHealth(60_000, 60_000)
    const endpoints = [{ url: 'http://a/' }, { url: 'http://b/' }]
    health.recordFailure('http://a/')
    expect(orderByHealth(endpoints, health)).toEqual([{ url: 'http://b/' }])
  })

  it('clears all state', () => {
    const health = new EndpointHealth()
    health.recordFailure('http://a/')
    health.clear()
    expect(health.isCoolingDown('http://a/')).toBe(false)
  })
})
