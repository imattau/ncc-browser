import { describe, expect, it } from 'vitest'
import { servicesForLocalUrl, type HostedService, type HostingState } from '../src/shared/hosting'

const OWNER = 'a'.repeat(64)

function service(id: string, urls: string[], owner?: string): HostedService {
  return {
    id,
    service: id,
    title: id,
    ...(owner ? { owner } : {}),
    endpoints: urls.map((url) => ({ url, priority: 1000 })),
    ttlSeconds: 86_400,
    visibility: 'private',
    anchor: false,
    createdAt: 1,
    updatedAt: 1
  }
}

function ids(services: HostedService[], url: string, https: HostingState['https'] = []): string[] {
  return servicesForLocalUrl({ services, https }, url, OWNER).map(({ id }) => id)
}

describe('services that already use a local page’s server', () => {
  it('matches the loopback port whatever the scheme or loopback name', () => {
    const saved = [service('app', ['https://localhost:8080/', 'https://192.168.1.5:8080/'])]

    expect(ids(saved, 'http://localhost:8080')).toEqual(['app'])
    expect(ids(saved, 'http://127.0.0.1:8080')).toEqual(['app'])
    expect(ids(saved, 'http://localhost:3000')).toEqual([])
  })

  it('matches a page opened through the service’s HTTPS front', () => {
    const saved = [service('app', ['http://localhost:8080/'])]
    const front = [
      { serviceId: 'app', listenPort: 8443, targetPort: 8080, endpoints: [], routerPorts: [] }
    ]

    expect(ids(saved, 'https://localhost:8443', front)).toEqual(['app'])
  })

  it('ignores another machine’s port and another identity’s service', () => {
    const saved = [
      service('remote', ['http://192.168.1.9:8080/']),
      service('theirs', ['http://localhost:8080/'], 'b'.repeat(64)),
      service('mine', ['http://localhost:8080/'], OWNER)
    ]

    expect(ids(saved, 'http://localhost:8080')).toEqual(['mine'])
    expect(ids(saved, 'https://example.com:8080')).toEqual([])
  })
})
