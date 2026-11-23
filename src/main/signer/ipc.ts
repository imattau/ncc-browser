import { ipcMain, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import type { TabKind } from '@shared/types'
import { agentIdForContents } from '../automation/agent-tabs'
import type { AutomationController } from '../automation/controller'
import { validateTemplate } from './crypto'
import { signerOriginFromUrl } from './origin'
import { ACTION_BY_KIND, requireText, type Caller, type Nip07Service } from './service'

/**
 * NIP-07 IPC endpoints, callable only from a sandboxed content preload. The caller's
 * origin is derived from the main frame, never from a parameter supplied by the page.
 */
export interface Nip07ContentSession {
  session: Session
  kind: TabKind
}

/** Kind 22242 is NIP-42 relay authentication: signed once per relay, no user content. */
const RELAY_AUTH_KIND = 22242

type Resolved =
  | { kind: 'human'; caller: Caller }
  | { kind: 'agent'; agentId: string; origin: string }

export function registerNip07(
  service: Nip07Service,
  sessions: Nip07ContentSession[],
  /** Late-bound: the automation controller may not exist yet when this is called. */
  getAutomation?: () => Pick<AutomationController, 'authorizeAndSign'> | null
): void {
  const agentCall = <T>(
    resolved: Extract<Resolved, { kind: 'agent' }>,
    action: string,
    run: Parameters<AutomationController['authorizeAndSign']>[3]
  ): Promise<T> => {
    const automation = getAutomation?.()
    if (!automation) throw new Error('Agent control is not available')
    return automation.authorizeAndSign(resolved.agentId, resolved.origin, action, run) as Promise<T>
  }

  ipcMain.handle('nip07:get-public-key', (event) => {
    const resolved = callerOf(event, sessions)
    if (resolved.kind === 'agent') {
      return agentCall(resolved, 'see its public key', (signer) => signer.getPublicKey())
    }
    return service.getPublicKey(resolved.caller)
  })

  ipcMain.handle('nip07:sign-event', (event, template: unknown) => {
    const resolved = callerOf(event, sessions)
    if (resolved.kind === 'agent') {
      const normalized = validateTemplate(template)
      const action =
        ACTION_BY_KIND[normalized.kind] ??
        (normalized.kind === RELAY_AUTH_KIND
          ? 'log in to a relay'
          : `sign a kind ${normalized.kind} event`)
      return agentCall(resolved, action, (signer) => signer.signEvent(normalized))
    }
    return service.signEvent(resolved.caller, template)
  })

  ipcMain.handle('nip07:nip04-encrypt', (event, peer: string, plaintext: unknown) => {
    const resolved = callerOf(event, sessions)
    if (resolved.kind === 'agent') {
      const text = requireText(plaintext, 'Plaintext')
      return agentCall(resolved, 'encrypt a NIP-04 message', (signer) => signer.nip04Encrypt(peer, text))
    }
    return service.nip04Encrypt(resolved.caller, peer, plaintext)
  })

  ipcMain.handle('nip07:nip04-decrypt', (event, peer: string, ciphertext: unknown) => {
    const resolved = callerOf(event, sessions)
    if (resolved.kind === 'agent') {
      const text = requireText(ciphertext, 'Ciphertext')
      return agentCall(resolved, 'decrypt a NIP-04 message', (signer) => signer.nip04Decrypt(peer, text))
    }
    return service.nip04Decrypt(resolved.caller, peer, ciphertext)
  })

  ipcMain.handle('nip07:nip44-encrypt', (event, peer: string, plaintext: unknown) => {
    const resolved = callerOf(event, sessions)
    if (resolved.kind === 'agent') {
      const text = requireText(plaintext, 'Plaintext')
      return agentCall(resolved, 'encrypt a NIP-44 message', (signer) => signer.nip44Encrypt(peer, text))
    }
    return service.nip44Encrypt(resolved.caller, peer, plaintext)
  })

  ipcMain.handle('nip07:nip44-decrypt', (event, peer: string, ciphertext: unknown) => {
    const resolved = callerOf(event, sessions)
    if (resolved.kind === 'agent') {
      const text = requireText(ciphertext, 'Ciphertext')
      return agentCall(resolved, 'decrypt a NIP-44 message', (signer) => signer.nip44Decrypt(peer, text))
    }
    return service.nip44Decrypt(resolved.caller, peer, ciphertext)
  })

  ipcMain.handle('nip07:get-relays', () => service.getRelays())
}

function callerOf(event: IpcMainInvokeEvent, sessions: Nip07ContentSession[]): Resolved {
  const content = sessions.find((entry) => entry.session === event.sender.session)
  if (!content) {
    throw new Error('NIP-07 is only available to page content')
  }

  let frame
  try {
    frame = event.senderFrame
  } catch {
    throw new Error('The requesting frame is gone')
  }
  if (!frame) throw new Error('The requesting frame is gone')
  if (frame.parent) throw new Error('NIP-07 is only available to the top-level frame')

  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    throw new Error('NIP-07 is not available on this page')
  }

  const resolved = signerOriginFromUrl(url.toString())
  if (!resolved) {
    throw new Error(
      url.protocol === 'ncc:' ? 'Not an NCC page' : 'NIP-07 is not available on this page'
    )
  }

  // Only an ordinary tab the `tab_new` tool created is ever tagged; private/Tor tabs
  // are never reachable by automation at all, and merely navigating or clicking on an
  // existing tab never tags it, so every other page is unaffected.
  if (content.kind === 'normal') {
    const agentId = agentIdForContents(event.sender as WebContents)
    if (agentId) return { kind: 'agent', agentId, origin: resolved.origin }
  }

  return {
    kind: 'human',
    caller: {
      origin: resolved.origin,
      label: resolved.label,
      kind: content.kind,
      ephemeral: content.kind !== 'normal',
      torTab: content.kind === 'tor'
    }
  }
}
