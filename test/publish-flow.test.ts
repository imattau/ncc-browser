import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateNsiteSiteId } from '../src/shared/nsite-publish'
import {
  checkAddresses,
  serviceNextStep,
  suggestSiteId,
  suggestSiteTitle
} from '../src/renderer/src/lib/publish-flow'
import {
  dismissServiceSetup,
  resumeServiceSetup,
  serviceSetup,
  startServiceSetup
} from '../src/renderer/src/components/hosting/serviceSetup'
import {
  discardServiceDraft,
  editServiceDraft,
  openServiceDraft,
  parseUnfinishedService,
  serviceDraft,
  setServiceDraftExtras
} from '../src/renderer/src/components/hosting/serviceDraft'
import { servicePayload } from '../src/renderer/src/components/hosting/useHostingDraft'
import { EMPTY_DRAFT } from '../src/renderer/src/components/hosting/types'

describe('suggested site names', () => {
  it('keeps whole words within the address limit', () => {
    expect(suggestSiteId('My holiday site')).toBe('my-holiday')
    expect(suggestSiteId('Café menu')).toBe('cafe-menu')
    expect(suggestSiteId('Extraordinarily long')).toBe('extraordinari')
    expect(suggestSiteId('!!!')).toBe('')
  })

  it('only suggests names the publisher accepts', () => {
    for (const title of ['A', 'twelve chars x', '2024 — Photos!', 'abcdefghijkl-mnop']) {
      expect(validateNsiteSiteId(suggestSiteId(title))).toBeNull()
    }
  })

  it('does not name a site after a build folder', () => {
    expect(suggestSiteTitle('dist')).toBe('')
    expect(suggestSiteTitle('my-holiday_site')).toBe('My holiday site')
  })
})

describe('address checks', () => {
  it('completes bare addresses and spots ones that only work here', () => {
    expect(checkAddresses(' 127.0.0.1:8080 \n\n')).toMatchObject({
      entries: [{ line: '127.0.0.1:8080', url: 'http://127.0.0.1:8080/' }],
      onlyLoopback: true
    })
    expect(checkAddresses('localhost:1\nhttp://192.168.1.2')).toMatchObject({
      hasLoopback: true,
      onlyLoopback: false
    })
    expect(checkAddresses('ftp://nope').invalid).toEqual(['ftp://nope'])
    expect(checkAddresses('')).toMatchObject({ hasLoopback: false, onlyLoopback: false })
  })

  it('saves completed addresses and keeps their certificate pins', () => {
    const payload = servicePayload(
      {
        ...EMPTY_DRAFT,
        title: 'Photos',
        endpoints: '192.168.1.2:81\nhttps://photos.example',
        pins: { 'https://photos.example': 'pin' }
      },
      false
    )
    expect(payload.endpoints).toEqual([
      'http://192.168.1.2:81/',
      { url: 'https://photos.example/', k: 'pin', priority: 1000 }
    ])
  })
})

describe('a saved service’s next step', () => {
  const service = {
    endpoints: [{ url: 'http://192.168.1.2/', priority: 1 }],
    visibility: 'private' as const,
    ttlSeconds: 100,
    lastPublishedAt: 1_000
  }

  it('asks for what is missing, in order', () => {
    expect(serviceNextStep({ ...service, endpoints: [] }, 0, 1_001)?.action).toBe('edit')
    expect(serviceNextStep({ ...service, lastPublishedAt: undefined }, 0, 1_001)?.action).toBe('publish')
    expect(serviceNextStep({ ...service, lastPublishError: 'no' }, 0, 1_001)?.button).toBe('Try again')
    expect(serviceNextStep(service, 0, 1_100)?.button).toBe('Publish again')
    expect(serviceNextStep(service, 0, 1_001)?.action).toBe('people')
    expect(
      serviceNextStep({ ...service, endpoints: [{ url: 'http://127.0.0.1/', priority: 1 }] }, 0, 1_001)?.action
    ).toBe('onion')
  })

  it('says nothing once there is nothing left to do', () => {
    expect(serviceNextStep(service, 1, 1_001)).toBeNull()
    expect(serviceNextStep({ ...service, visibility: 'public' }, 0, 1_001)).toBeNull()
  })
})

describe('setting up a new service', () => {
  const payload = { title: 'Photos', endpoints: ['http://127.0.0.1:1/'] }
  const statuses = () => serviceSetup.get()?.tasks.map((task) => `${task.key}:${task.status}`)

  function fakeApi() {
    const services: Array<{ id: string }> = [{ id: 'old' }]
    const api = {
      hostingState: vi.fn(async () => ({ services: [...services] })),
      hostingCreate: vi.fn(async () => {
        services.push({ id: 'new' })
        return { services: [...services] }
      }),
      hostingPublishOnion: vi.fn(async () => ({ onion: { verifiedAt: 1 } })),
      hostingPublish: vi.fn(async () => ({ accepted: 2, relays: 3, shares: [] }))
    }
    vi.stubGlobal('window', { ncc: api })
    return api
  }

  afterEach(() => {
    dismissServiceSetup()
    vi.unstubAllGlobals()
  })

  it('saves, creates the Tor address and publishes, in that order', async () => {
    const api = fakeApi()
    await startServiceSetup(payload, { tor: true, publish: true })
    expect(statuses()).toEqual(['save:done', 'tor:done', 'publish:done'])
    expect(serviceSetup.get()).toMatchObject({ status: 'done', serviceId: 'new' })
    expect(api.hostingPublish).toHaveBeenCalledWith('new')
    expect(serviceSetup.get()?.tasks[2].detail).toBe('Accepted by 2 of 3 relays.')
  })

  it('stops at a failure, and retrying does not save a second service', async () => {
    const api = fakeApi()
    api.hostingPublish.mockRejectedValueOnce(new Error('no relay'))
    await startServiceSetup(payload, { tor: false, publish: true })
    expect(statuses()).toEqual(['save:done', 'publish:failed'])
    expect(serviceSetup.get()?.status).toBe('failed')
    await resumeServiceSetup()
    expect(serviceSetup.get()?.status).toBe('done')
    expect(api.hostingCreate).toHaveBeenCalledTimes(1)
  })

  it('can publish without a Tor address that failed', async () => {
    const api = fakeApi()
    api.hostingPublishOnion.mockRejectedValue(new Error('no Tor'))
    await startServiceSetup(payload, { tor: true, publish: true })
    expect(statuses()).toEqual(['save:done', 'tor:failed', 'publish:pending'])
    expect(api.hostingPublish).not.toHaveBeenCalled()
    await resumeServiceSetup(true)
    expect(statuses()).toEqual(['save:done', 'tor:skipped', 'publish:done'])
  })

  it('does nothing more when saving fails', async () => {
    const api = fakeApi()
    api.hostingCreate.mockRejectedValue(new Error('already published'))
    await startServiceSetup(payload, { tor: false, publish: true })
    expect(serviceSetup.get()).toMatchObject({ status: 'failed', serviceId: null })
    expect(api.hostingPublish).not.toHaveBeenCalled()
  })
})

describe('keeping an unfinished service', () => {
  const entry = {
    version: 1,
    key: 'k',
    draft: { ...EMPTY_DRAFT, title: 'Photos', endpoints: '127.0.0.1:1' },
    step: 2,
    wantTor: true,
    certificate: null,
    mappedUrl: null,
    baseUpdatedAt: null,
    savedAt: 1
  }

  it('reads a kept form back, set aside until the user continues', () => {
    expect(parseUnfinishedService(entry)).toMatchObject({
      step: 2,
      wantTor: true,
      parked: true,
      draft: { title: 'Photos' }
    })
  })

  it('ignores anything that is not a form', () => {
    for (const raw of [null, 'x', {}, { ...entry, version: 2 }, { ...entry, draft: { title: 1 } }]) {
      expect(parseUnfinishedService(raw)).toBeNull()
    }
  })

  describe('on disk', () => {
    const saved: unknown[] = []
    beforeEach(() => {
      saved.length = 0
      vi.useFakeTimers()
      vi.stubGlobal('window', {
        ncc: {
          publishDraftSave: vi.fn(async (_kind: string, value: unknown) => {
            saved.push(value)
          })
        }
      })
    })
    afterEach(() => {
      discardServiceDraft()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })
    const type = (title: string) => editServiceDraft((draft) => ({ ...draft, title }))

    it('is written once the user types, and removed when discarded', () => {
      openServiceDraft({ ...EMPTY_DRAFT })
      vi.runAllTimers()
      expect(saved).toEqual([])
      type('Ph')
      type('Photos')
      vi.runAllTimers()
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ version: 1, draft: { title: 'Photos' } })
      expect(parseUnfinishedService(saved[0])?.draft.title).toBe('Photos')
      discardServiceDraft()
      expect(saved.at(-1)).toBeNull()
    })

    it('counts moving on through a filled-in form as work to keep', () => {
      openServiceDraft({ ...EMPTY_DRAFT, title: 'From a page' })
      setServiceDraftExtras({ step: 1 })
      vi.runAllTimers()
      expect(saved[0]).toMatchObject({ step: 1, draft: { title: 'From a page' } })
    })

    it('never writes a form that came from a private tab', () => {
      openServiceDraft({ ...EMPTY_DRAFT }, { memoryOnly: true })
      type('Secret')
      setServiceDraftExtras({ step: 1 })
      vi.runAllTimers()
      discardServiceDraft()
      expect(saved).toEqual([])
    })

    it('only discards the form it was asked to', () => {
      openServiceDraft({ ...EMPTY_DRAFT })
      type('Newer')
      discardServiceDraft('an older form')
      expect(serviceDraft.get()?.draft.title).toBe('Newer')
    })
  })
})
