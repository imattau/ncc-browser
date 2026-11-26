import { ipcMain } from 'electron'
import { nip19 } from 'nostr-tools'
import type { ApprovalBroker } from '../approval'
import type { ConfigStore } from '../config'
import { isChromeSender, resetCaches, shellForSender, type CacheResettingDeps } from '../ipc/shared'
import type { PasswordService } from '../passwords/service'
import type { RelayPool } from '../relay/pool'
import type { BrowserShell } from '../shell'
import type { IdentityManager } from './manager'
import { signerOriginFromUrl } from './origin'
import type { PermissionStore } from './permissions'

export interface SignerChromeIpcDeps extends CacheResettingDeps {
  shell: BrowserShell
  config: ConfigStore
  identity: IdentityManager
  permissions: PermissionStore
  approvals: ApprovalBroker
  passwords: PasswordService
  relayPool: RelayPool
}

/**
 * Identity switching, identity mutation, signer approvals and permissions, and the
 * "share to Nostr" action. Changing the active identity invalidates every memoised
 * resolution, so those handlers also reset caches and tell the password manager.
 */
export function registerSignerChromeIpc(deps: SignerChromeIpcDeps): void {
  const shellFor = (event: Electron.IpcMainInvokeEvent): BrowserShell =>
    shellForSender(event, deps.shell)
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean => isChromeSender(event)

  ipcMain.handle('ncc:identity-status', () => deps.identity.status())
  ipcMain.handle('ncc:identity-list', () => deps.identity.list())
  ipcMain.handle('ncc:identity-select', async (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const previousPubkey = deps.identity.status().hexPubkey ?? null
    const status = await deps.identity.select(String(id ?? ''))
    const nextPubkey = deps.identity.status().hexPubkey ?? null
    if (nextPubkey !== previousPubkey) deps.shell.notifySignerAccountsChanged(nextPubkey)
    resetCaches(deps)
    return status
  })
  ipcMain.handle('ncc:identity-default', (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const previousDefault = deps.identity.list().defaultId
    const list = deps.identity.setDefault(String(id ?? ''))
    if (list.defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return list
  })
  ipcMain.handle('ncc:identity-remove-profile', async (event, id: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const previousDefault = deps.identity.list().defaultId
    const previousPubkey = deps.identity.status().hexPubkey ?? null
    const status = await deps.identity.remove(String(id ?? ''))
    const nextPubkey = deps.identity.status().hexPubkey ?? null
    if (nextPubkey !== previousPubkey) deps.shell.notifySignerAccountsChanged(nextPubkey)
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })
  ipcMain.handle('ncc:share-nostr', async (event, rawComment: unknown) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const page = shellFor(event).getActivePage()
    if (!page) throw new Error('Open a page first')
    const state = shellFor(event).getState()
    if (state.tabKind !== 'normal') throw new Error('Normal tabs only')
    const provider = deps.identity.provider()
    if (!provider) throw new Error('Sign in first')
    const relays = deps.config.get().relays.map((entry) => entry.url).filter(Boolean)
    if (!relays.length) throw new Error('No relays are configured')
    const comment = typeof rawComment === 'string' ? rawComment.slice(0, 2000) : ''
    const content = `${page.title && page.title !== 'New tab' ? `${page.title}\n` : ''}${page.url}${comment ? `\n\n${comment}` : ''}`
    const eventTemplate = { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }
    const signed = await provider.signEvent(eventTemplate)
    const results = await Promise.allSettled(relays.map((url) => deps.relayPool.publish(url, signed)))
    return { accepted: results.filter((result) => result.status === 'fulfilled').length, relays: relays.length, error: results.every((result) => result.status === 'rejected') ? String((results[0] as PromiseRejectedResult)?.reason ?? '') : undefined }
  })

  ipcMain.handle('ncc:identity-import', async (event, secret: unknown) => {
    const previousDefault = deps.identity.list().defaultId
    const status = await deps.identity.importLocal(String(secret ?? ''))
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    // Unlike generate, a failed save here does not fail the import: the key is already
    // in place either way, and the vault being locked or briefly unreachable is not a
    // reason to tell the person their import itself failed.
    const imported = deps.identity.activeLocalSecret()
    if (imported && status.npub) {
      const saved = await deps.passwords.saveIdentitySecret(nip19.nsecEncode(imported), status.npub)
      if (!saved.ok) console.warn(`[identity] could not save imported key's nsec to the password vault: ${saved.error ?? 'unknown error'}`)
    }
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-generate', async (event) => {
    if (!fromChrome(event)) throw new Error('Not allowed')
    const previousDefault = deps.identity.list().defaultId
    const status = await deps.identity.generateLocal()
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    const secret = deps.identity.activeLocalSecret()
    if (!secret || !status.npub) throw new Error('Could not read the generated local key')
    const saved = await deps.passwords.saveIdentitySecret(nip19.nsecEncode(secret), status.npub)
    if (!saved.ok) throw new Error(`Identity created, but its nsec could not be saved in the password manager: ${saved.error ?? 'unknown error'}`)
    resetCaches(deps)
    return status
  })
  ipcMain.handle('ncc:identity-generate-ephemeral', () => {
    const result = deps.identity.generateEphemeral()
    resetCaches(deps)
    return result
  })
  ipcMain.handle('ncc:identity-ephemeral-secret', () => deps.identity.ephemeralNsec())
  ipcMain.handle('ncc:identity-save-ephemeral', async () => {
    const previousDefault = deps.identity.list().defaultId
    const status = await deps.identity.saveEphemeral()
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })
  ipcMain.handle('ncc:identity-clear-ephemeral', () => {
    const status = deps.identity.clearEphemeral()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-remove', async () => {
    const previousDefault = deps.identity.list().defaultId
    const status = await deps.identity.removeLocal()
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-connect-bunker', async (event, url: unknown) => {
    const previousDefault = deps.identity.list().defaultId
    const status = await deps.identity.connectRemote(String(url ?? ''))
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:identity-disconnect', async () => {
    const previousDefault = deps.identity.list().defaultId
    const status = await deps.identity.disconnectRemote()
    if (deps.identity.list().defaultId !== previousDefault) deps.passwords.onIdentityChanged()
    resetCaches(deps)
    return status
  })

  ipcMain.handle('ncc:signer-permissions', () => deps.permissions.list())

  ipcMain.handle('ncc:signer-pending', (event) => (fromChrome(event) ? deps.approvals.list() : []))

  ipcMain.handle('ncc:signer-origin', (event, raw: unknown) => {
    if (!fromChrome(event)) return null
    const resolved = signerOriginFromUrl(String(raw ?? ''))
    if (!resolved) return null
    return { ...resolved, trusted: deps.permissions.isTrusted(resolved.origin) }
  })

  ipcMain.handle('ncc:signer-trust', (event, payload: unknown) => {
    if (!fromChrome(event)) return null
    if (!payload || typeof payload !== 'object') return null
    const { url, trusted } = payload as { url?: unknown; trusted?: unknown }
    const resolved = signerOriginFromUrl(String(url ?? ''))
    if (!resolved) return null
    if (trusted === true) deps.permissions.trust(resolved.origin, resolved.label)
    else deps.permissions.revoke(resolved.origin)
    return { ...resolved, trusted: deps.permissions.isTrusted(resolved.origin) }
  })

  ipcMain.handle('ncc:revoke-permission', (event, origin: unknown) => {
    if (typeof origin === 'string') deps.permissions.revoke(origin)
    return deps.permissions.list()
  })

  ipcMain.handle('ncc:signer-response', (event, payload: unknown) => {
    // Only the trusted chrome renderer may answer a signer request.
    if (!fromChrome(event)) return
    if (!payload || typeof payload !== 'object') return
    const { id, allow, remember } = payload as {
      id?: unknown
      allow?: unknown
      remember?: unknown
    }
    if (typeof id !== 'string') return
    deps.approvals.respond(id, { allow: allow === true, remember: remember === true })
  })
}
