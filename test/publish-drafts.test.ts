import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('../src/main/ipc-guard', () => ({ requireChrome: () => undefined }))

const { PublishDraftStore } = await import('../src/main/publish-drafts')

const path = () => join(mkdtempSync(join(tmpdir(), 'ncc-drafts-')), 'publish-drafts.json')

describe('PublishDraftStore', () => {
  it('keeps one draft of each kind across restarts, readable only by the user', () => {
    const file = path()
    const store = new PublishDraftStore(file)
    store.save('service', { title: 'Photos' })
    store.save('site', { title: 'Lake' })
    expect(new PublishDraftStore(file).load('service')).toEqual({ title: 'Photos' })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    store.save('service', null)
    expect(store.load('service')).toBeNull()
    expect(store.load('site')).toEqual({ title: 'Lake' })
    store.save('site', null)
    expect(existsSync(file)).toBe(false)
  })

  it('starts empty from a damaged file and refuses an oversized draft', () => {
    const file = path()
    writeFileSync(file, '{not json')
    const store = new PublishDraftStore(file)
    expect(store.load('site')).toBeNull()
    expect(() => store.save('site', { text: 'x'.repeat(70_000) })).toThrow(/too large/)
    expect(readFileSync(file, 'utf8')).toBe('{not json')
  })
})
