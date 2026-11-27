import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NsiteProgress } from '../src/shared/nsite-publish'
import {
  listenForSiteProgress,
  parseKeptSite,
  patchSiteDraft,
  pickSiteFolder,
  publishSite,
  publishTasks,
  resetSiteFlow,
  siteFlow
} from '../src/renderer/src/components/sites/siteFlow'

let report: (progress: NsiteProgress) => void = () => undefined
let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void }
const scan = { token: 't', folderName: 'dist', files: [{ path: '/index.html', hash: '', size: 1 }], totalBytes: 1, problems: [] as string[] }
const kept: unknown[] = []
const api = {
  publishDraftSave: vi.fn(async (_kind: string, value: unknown) => {
    kept.push(value)
  }),
  nsitePickFolder: vi.fn(async () => scan),
  nsitePublish: vi.fn(
    () => new Promise((resolve, reject) => (settle = { resolve, reject }))
  ),
  onNsiteProgress: vi.fn((listener: (progress: NsiteProgress) => void) => {
    report = listener
    return () => undefined
  })
}
vi.stubGlobal('window', { ncc: api })

const statuses = () => publishTasks(siteFlow.get().job!).map((task) => task.status)

afterEach(() => resetSiteFlow())

describe('the site publishing steps', () => {
  it('moves to naming a usable folder, and stays put for one with problems', async () => {
    await pickSiteFolder()
    expect(siteFlow.get().step).toBe(1)
    expect(siteFlow.get().draft).toMatchObject({ title: '', siteId: '' })
    resetSiteFlow()
    api.nsitePickFolder.mockResolvedValueOnce({ ...scan, problems: ['no index.html'] })
    await pickSiteFolder()
    expect(siteFlow.get().step).toBe(0)
  })

  it('follows the title until the short name is typed', async () => {
    await pickSiteFolder()
    patchSiteDraft({ title: 'Lake photos' })
    expect(siteFlow.get().draft.siteId).toBe('lake-photos')
    patchSiteDraft({ siteId: 'lake' })
    patchSiteDraft({ title: 'Something else' })
    await pickSiteFolder()
    expect(siteFlow.get().draft).toMatchObject({ title: 'Something else', siteId: 'lake' })
  })

  it('reports each stage, marks the one that failed, and runs one job at a time', async () => {
    listenForSiteProgress()
    listenForSiteProgress()
    expect(api.onNsiteProgress).toHaveBeenCalledTimes(1)
    await pickSiteFolder()
    api.nsitePublish.mockClear()
    const running = publishSite()
    void publishSite()
    expect(api.nsitePublish).toHaveBeenCalledTimes(1)
    report({ phase: 'uploading', done: 1, total: 4, label: '', current: '/a' })
    expect(siteFlow.get().job).toMatchObject({ uploaded: 1, total: 4, current: '/a' })
    expect(statuses()).toEqual(['running', 'pending', 'pending'])
    report({ phase: 'signing', done: 0, total: 1, label: '' })
    expect(statuses()).toEqual(['done', 'running', 'pending'])
    report({ phase: 'publishing', done: 0, total: 3, label: '' })
    expect(statuses()).toEqual(['done', 'done', 'running'])
    settle.reject(new Error('no relay'))
    await running
    expect(statuses()).toEqual(['done', 'done', 'failed'])
    expect(publishTasks(siteFlow.get().job!)[2].detail).toBe('no relay')
  })

  it('keeps a running file check in view when another folder is chosen', async () => {
    siteFlow.set((flow) => ({ ...flow, verify: { id: 'a', running: true, done: 1, total: 2 } }))
    await pickSiteFolder()
    resetSiteFlow()
    expect(siteFlow.get().verify?.running).toBe(true)
    siteFlow.set((flow) => ({ ...flow, verify: null }))
  })

  it('keeps typed details on disk without the folder, and forgets them on discard', async () => {
    await pickSiteFolder()
    await new Promise((resolve) => setTimeout(resolve, 350))
    kept.length = 0
    patchSiteDraft({ title: 'Lake' })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(kept).toHaveLength(1)
    expect(kept[0]).not.toHaveProperty('scan')
    expect(JSON.stringify(kept[0])).not.toContain('"token"')
    expect(parseKeptSite(kept[0])).toMatchObject({
      draft: { title: 'Lake', siteId: 'lake' },
      recovered: { folderName: 'dist', publishing: false }
    })
    resetSiteFlow()
    expect(kept.at(-1)).toBeNull()
    expect(parseKeptSite({ version: 1, draft: { title: 2 } })).toBeNull()
  })

  it('shows a cancelled publish as stopped, not failed', async () => {
    await pickSiteFolder()
    const running = publishSite()
    settle.resolve({ cancelled: true })
    await running
    expect(statuses()).toEqual(['skipped', 'pending', 'pending'])
  })
})
