import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The Android shell is plain JavaScript.
import { createSync } from '../mobile/sync.js'

const OWNER = 'local:' + '0'.repeat(64)
const KEY = 'a'.repeat(64)

/** The Android sync feature with a stand-in for the native side and for storage. */
function phone({ identities = true } = {}) {
  const stored = new Map<string, string>()
  stored.set('ncc.sync', JSON.stringify({ identities, identityVaultOwnerId: OWNER, deviceId: '0123456789abcdef' }))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value)
  })
  const log: string[] = []
  const profiles = [{ id: OWNER, npub: 'npub1owner' }, { id: `local:${KEY}`, npub: 'npub1other' }]
  const native = {
    release: null as null | (() => void),
    hold: false,
    failRemove: false,
    outcome: { imported: 0, marks: [] as unknown[], unexclude: [] as string[] },
    sent: [] as unknown[]
  }
  const invoke = vi.fn(async (command: string, args?: { id?: string; localState?: unknown }) => {
    if (command === 'identity_profiles') return { identities: [...profiles], default_id: OWNER }
    if (command === 'sync_identity_vault') {
      log.push('sync starts')
      native.sent.push(args?.localState)
      if (native.hold) await new Promise<void>((resolve) => (native.release = resolve))
      log.push('sync ends')
      return native.outcome
    }
    if (command === 'identity_remove_profile') {
      if (native.failRemove) throw new Error('disk')
      log.push('removed')
      profiles.splice(profiles.findIndex((entry) => entry.id === args?.id), 1)
    }
    return null
  })
  // No screen here: the prompts are checked on a device.
  const element = () => null
  const feature = createSync({
    invoke, set: () => undefined, byId: element, getPanel: () => 'home',
    readList: () => [], writeList: () => undefined, readNumber: () => 0, writeNumber: () => undefined,
    renderBookmarks: () => undefined, renderHistory: () => undefined, renderTabGrid: () => undefined,
    getTabs: () => [], getSwitcherKind: () => 'normal'
  } as never)
  const saved = () => JSON.parse(stored.get('ncc.sync')!)
  return { feature, native, log, saved, invoke }
}

afterEach(() => vi.unstubAllGlobals())

describe('removing an identity on Android', () => {
  it('waits for a running sync, and tells the next one not to bring the key back', async () => {
    const p = phone()
    p.native.hold = true
    const syncing = p.feature.syncNow()
    await vi.waitFor(() => expect(p.native.release).not.toBeNull())
    const removing = p.feature.removeIdentity(`local:${KEY}`, 'device')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(p.log).toEqual(['sync starts'])
    p.native.hold = false
    p.native.release!()
    await Promise.all([syncing, removing])
    expect(p.log.slice(0, 3)).toEqual(['sync starts', 'sync ends', 'removed'])
    await vi.waitFor(() => expect(p.native.sent.length).toBeGreaterThan(1))
    expect(p.native.sent.at(-1)).toEqual({ excluded: [KEY], marks: [] })
  })

  it('marks it for every device only when asked to', async () => {
    const p = phone()
    await p.feature.removeIdentity(`local:${KEY}`, 'everywhere')
    expect(p.saved().identityState.marks).toMatchObject([{ pubkey: KEY, removed: true }])
  })

  it('refuses to remove the key that protects the list', async () => {
    const p = phone()
    await expect(p.feature.removeIdentity(OWNER, 'device')).rejects.toThrow(/protects your synced identity list/)
    expect(p.log).not.toContain('removed')
  })

  it('with sync off, remembers the removal and offers no removal everywhere', async () => {
    const p = phone({ identities: false })
    await expect(p.feature.removeIdentity(`local:${KEY}`, 'everywhere')).rejects.toThrow(/Turn on identity sync/)
    await p.feature.removeIdentity(`local:${KEY}`, 'device')
    expect(p.saved().identityState.excluded).toEqual([KEY])
  })

  it('records nothing if the key could not be removed', async () => {
    const p = phone()
    p.native.failRemove = true
    await expect(p.feature.removeIdentity(`local:${KEY}`, 'everywhere')).rejects.toThrow('disk')
    expect(p.saved().identityState ?? { excluded: [], marks: [] }).toEqual({ excluded: [], marks: [] })
  })

  it('asks about a key removed elsewhere, and can keep it or sync it again', async () => {
    const p = phone()
    p.native.outcome.marks = [{ pubkey: KEY, removed: true, at: 5 }]
    await p.feature.syncNow()
    expect(p.feature.identityRemovals()).toMatchObject([{ pubkey: KEY, kept: false }])
    await p.feature.resolveRemoval(KEY, 'keep')
    expect(p.feature.identityRemovals()).toMatchObject([{ kept: true }])
    p.native.outcome.marks = []
    await p.feature.resolveRemoval(KEY, 'restore')
    expect(p.feature.identityRemovals()).toEqual([])
    expect(p.saved().identityState.marks).toMatchObject([{ pubkey: KEY, removed: false }])
  })
})
