import { randomBytes } from 'node:crypto'
import { pageOriginFromUrl, type PasswordEntry, type PasswordPage, type PasswordVault } from '@shared/passwords'
import {
  makeAssertion,
  makeCredential,
  validateRpId,
  type PasskeyCreationOptions,
  type PasskeyRequestOptions
} from './passkeys'
import type { PasswordSaveResult } from '@shared/passwords'
import type { ProviderLike } from './service'
import { emptyVault } from './vault-ops'

export interface WebauthnContext {
  unlocked: () => boolean
  vault: () => PasswordVault | null
  pubkey: () => string | null
  now: () => number
  touch: () => void
  requireProvider: () => ProviderLike
  ensureLatest: (provider: ProviderLike, pubkey: string) => Promise<void>
  commit: (provider: ProviderLike, pubkey: string, next: PasswordVault) => Promise<PasswordSaveResult>
}

export function hasWebauthnCredentials(ctx: WebauthnContext): boolean {
  return (
    !!ctx.unlocked() &&
    !!ctx.vault()?.entries.some((entry) => entry.deleted !== true && !!entry.passkey)
  )
}

function pageMatches(page: PasswordPage | null, origin: string): boolean {
  // As on Android, no saved passkey is offered through Tor: it would name its owner.
  if (!page || page.kind === 'private' || page.kind === 'tor' || page.mode === 'blank' || page.mode === 'error') return false
  const parsed = pageOriginFromUrl(page.url)
  return !!parsed && parsed.scheme === 'https' && parsed.origin === new URL(origin).origin
}

export function hasWebauthnCredentialsForPage(
  ctx: WebauthnContext,
  page: PasswordPage | null,
  origin: string
): boolean {
  const vault = ctx.vault()
  if (!ctx.unlocked() || !vault) return false
  try {
    if (!pageMatches(page, origin)) return false
    const rpId = validateRpId(origin)
    return vault.entries.some(
      (entry) =>
        entry.deleted !== true &&
        entry.passkey?.rpId === rpId &&
        entry.passkey.discoverable
    )
  } catch {
    return false
  }
}

export function isWebauthnAuthenticatorAvailable(ctx: WebauthnContext): boolean {
  return !!ctx.unlocked() && !!ctx.vault() && !!ctx.pubkey()
}

function allowedIds(options: PasskeyRequestOptions): Set<string> {
  return new Set(
    (options.allowCredentials ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string')
  )
}

export function hasWebauthnCandidates(
  ctx: WebauthnContext,
  page: PasswordPage | null,
  origin: string,
  options: PasskeyRequestOptions
): boolean {
  const vault = ctx.vault()
  if (!ctx.unlocked() || !vault) return false
  try {
    if (!pageMatches(page, origin)) return false
    const rpId = validateRpId(origin, options.rpId)
    const allowed = allowedIds(options)
    return vault.entries.some((entry) => {
      const credential = entry.deleted !== true ? entry.passkey : undefined
      return (
        !!credential &&
        credential.rpId === rpId &&
        !(allowed.size && !allowed.has(credential.credentialId)) &&
        (allowed.size > 0 || credential.discoverable)
      )
    })
  } catch {
    return false
  }
}

export function canHandleWebauthn(
  ctx: WebauthnContext,
  page: PasswordPage | null,
  origin: string,
  operation: 'create' | 'get',
  input: PasskeyCreationOptions | PasskeyRequestOptions
): boolean {
  const vault = ctx.vault()
  if (!ctx.unlocked() || !vault) return false
  try {
    if (!pageMatches(page, origin)) return false
    const rpId = validateRpId(
      origin,
      operation === 'create'
        ? (input as PasskeyCreationOptions).rp?.id
        : (input as PasskeyRequestOptions).rpId
    )
    if (operation === 'create') {
      const options = input as PasskeyCreationOptions
      return (
        !options.pubKeyCredParams ||
        options.pubKeyCredParams.some(
          (param) => param.type === 'public-key' && param.alg === -7
        )
      )
    }
    const options = input as PasskeyRequestOptions
    const allowed = allowedIds(options)
    return vault.entries.some(
      (entry) =>
        entry.deleted !== true &&
        entry.passkey?.rpId === rpId &&
        (allowed.size
          ? allowed.has(entry.passkey.credentialId)
          : entry.passkey.discoverable)
    )
  } catch {
    return false
  }
}

export async function webauthnCreate(
  ctx: WebauthnContext,
  page: PasswordPage | null,
  origin: string,
  options: PasskeyCreationOptions,
  approve: (site: string, accounts: string[], action: string) => Promise<number | null>
): Promise<{ handled: boolean; response?: Record<string, string>; error?: string }> {
  if (!ctx.unlocked() || !ctx.vault() || !ctx.pubkey()) return { handled: false }
  if (!pageMatches(page, origin)) return { handled: false }
  let rpId: string
  try {
    rpId = validateRpId(origin, options.rp?.id)
  } catch {
    return { handled: false }
  }
  if (
    options.pubKeyCredParams &&
    !options.pubKeyCredParams.some((param) => param.type === 'public-key' && param.alg === -7)
  ) {
    return { handled: false }
  }
  const excluded = new Set(
    (options.excludeCredentials ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string')
  )
  if (
    ctx
      .vault()!
      .entries.some((entry) => entry.passkey?.rpId === rpId && excluded.has(entry.passkey.credentialId))
  ) {
    return { handled: true, error: 'InvalidStateError' }
  }
  const account = options.user?.name?.slice(0, 320) || 'Passkey'
  if ((await approve(new URL(origin).host, [account], 'Create passkey')) !== 0) {
    return { handled: true, error: 'NotAllowedError' }
  }
  try {
    const provider = ctx.requireProvider()
    const pubkey = ctx.pubkey()!
    await ctx.ensureLatest(provider, pubkey)
    const current = ctx.vault() ?? emptyVault()
    if (
      current.entries.some(
        (entry) =>
          entry.deleted !== true &&
          entry.passkey?.rpId === rpId &&
          excluded.has(entry.passkey.credentialId)
      )
    ) {
      return { handled: true, error: 'InvalidStateError' }
    }
    const made = makeCredential(options, new URL(origin).origin, rpId)
    const now = ctx.now()
    const entry: PasswordEntry = {
      id: randomBytes(16).toString('hex'),
      origin: new URL(origin).origin,
      title: `${new URL(origin).host} passkey`,
      username: made.credential.userName,
      password: '',
      notes: '',
      totp: '',
      createdAt: now,
      updatedAt: now,
      passkey: made.credential
    }
    await ctx.commit(provider, pubkey, { ...current, updatedAt: now, entries: [...current.entries, entry] })
    ctx.touch()
    return { handled: true, response: made.response }
  } catch (error) {
    return {
      handled: true,
      error: error instanceof Error ? error.message : 'NotAllowedError'
    }
  }
}

export async function webauthnGet(
  ctx: WebauthnContext,
  page: PasswordPage | null,
  origin: string,
  options: PasskeyRequestOptions,
  approve: (site: string, accounts: string[], action: string) => Promise<number | null>,
  selectedCredentialId?: string
): Promise<{ handled: boolean; response?: Record<string, string>; error?: string }> {
  const vault = ctx.vault()
  if (!ctx.unlocked() || !vault || !ctx.pubkey()) return { handled: false }
  if (!pageMatches(page, origin)) return { handled: false }
  let rpId: string
  try {
    rpId = validateRpId(origin, options.rpId)
  } catch {
    return { handled: false }
  }
  const allowed = allowedIds(options)
  const candidates = vault.entries.filter(
    (entry) =>
      entry.deleted !== true &&
      entry.passkey?.rpId === rpId &&
      (allowed.size ? allowed.has(entry.passkey.credentialId) : entry.passkey.discoverable) &&
      (!selectedCredentialId || entry.passkey.credentialId === selectedCredentialId)
  )
  if (!candidates.length) return { handled: false }
  try {
    // The unlocked vault is already the local authenticator's credential store.
    // Do not put a relay round-trip in the WebAuthn response path: a relying
    // party is waiting on this promise and synced credentials remain usable offline.
    const selected = await approve(
      new URL(origin).host,
      candidates.map(
        (entry) => entry.passkey!.userName || entry.passkey!.userDisplayName || 'Passkey'
      ),
      'Use passkey'
    )
    const chosen = selected == null ? undefined : candidates[selected]
    if (!chosen) return { handled: true, error: 'NotAllowedError' }
    const made = makeAssertion(
      chosen.passkey!,
      options.challenge,
      new URL(origin).origin,
      options.userVerification
    )
    ctx.touch()
    return { handled: true, response: made.response }
  } catch (error) {
    return {
      handled: true,
      error: error instanceof Error ? error.message : 'NotAllowedError'
    }
  }
}
