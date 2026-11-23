import { useState } from 'react'
import { Copy, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import type { IdentityProfile, IdentityStatus } from '@shared/types'
import { SectionHeading } from './shared'
import type { IdentityAdminApi } from './useIdentityAdmin'

/** The encryption-at-rest badge text for one identity row. */
function encryptionLabel(profile: IdentityProfile, identity: IdentityStatus | null): string {
  if (profile.active && identity) {
    if (identity.mode === 'nip46') return identity.persisted ? 'Session encrypted at rest' : 'Session not persisted'
    if (identity.source === 'env') return 'From NCC_IDENTITY_NSEC (development)'
    return identity.source === 'file' ? 'Encrypted with the OS keychain' : 'This session only'
  }
  if (profile.mode === 'nip46') return profile.persisted ? 'Session encrypted at rest' : 'Session not persisted'
  return profile.persisted ? 'Encrypted with the OS keychain' : 'This session only'
}

/**
 * The saved identity list (with each identity's encryption and connection
 * badge inline), local key import/generate, the throwaway-signer switch and
 * the NIP-46 bunker connection.
 */
export function IdentitySettings({
  identity,
  admin
}: {
  identity: IdentityStatus | null
  admin: IdentityAdminApi
}) {
  const {
    identityList,
    secret,
    setSecret,
    identityError,
    identityBusy,
    bunker,
    setBunker,
    connectBusy,
    remoteError,
    ephemeralSigner,
    runIdentity,
    updateIdentityProfile,
    connectBunker,
    toggleEphemeralSigner
  } = admin
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyProfileNpub = async (profile: IdentityProfile): Promise<void> => {
    if (!profile.npub) return
    try {
      await navigator.clipboard.writeText(profile.npub)
      setCopiedId(profile.id)
      window.setTimeout(() => setCopiedId((current) => (current === profile.id ? null : current)), 1400)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <>
      <SectionHeading
        title="Identity (NIP-07)"
        hint="Choose which local key or remote signer pages use through window.nostr. The secret key never leaves the main process."
      />

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Your identities</h3>
        <p className="mt-1 text-ui-11 text-[color:var(--color-muted)]">The active identity is used for new NIP-07 requests. The default starts first and is restored when no saved selection is available.</p>
        {identityList.identities.length ? (
          <ul className="mt-3 space-y-2">
            {identityList.identities.map((profile) => (
              <li key={profile.id} className="flex flex-col gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-ui-11 text-[color:var(--color-text-strong)]">{profile.npub ?? profile.id}</p>
                    <p className="mt-1 text-ui-105 text-[color:var(--color-muted)]">
                      {profile.mode === 'nip46' ? 'NIP-46 remote signer' : 'Local key'}
                      {profile.active ? ' · Active' : ''}{profile.isDefault ? ' · Default' : ''}
                      {profile.mode === 'nip46' ? (profile.connected ? ' · Connected' : ' · Connects on use') : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!profile.npub}
                      onClick={() => void copyProfileNpub(profile)}
                      title="Copy npub"
                      aria-label="Copy npub"
                      className="rounded-md p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
                    >
                      {copiedId === profile.id ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    {!profile.active ? <button type="button" disabled={identityBusy} onClick={() => void updateIdentityProfile(() => window.ncc.identitySelect(profile.id))} className="rounded-md border border-[color:var(--color-line)] px-2 py-1 text-ui-105 text-[color:var(--color-text)] disabled:opacity-40">Use</button> : null}
                    {!profile.isDefault ? <button type="button" disabled={identityBusy} onClick={() => void updateIdentityProfile(() => window.ncc.identitySetDefault(profile.id))} className="rounded-md border border-[color:var(--color-line)] px-2 py-1 text-ui-105 text-[color:var(--color-text)] disabled:opacity-40">Make default</button> : null}
                    <button
                      type="button"
                      disabled={identityBusy}
                      onClick={() => { if (window.confirm('Remove this identity from Nostr Navigator?')) void updateIdentityProfile(() => window.ncc.identityRemove(profile.id)) }}
                      className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-danger)]/30 px-2 py-1 text-ui-105 text-[color:var(--color-danger)] disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                      {profile.mode === 'nip46' ? 'Disconnect' : 'Remove'}
                    </button>
                  </div>
                </div>
                <p className="inline-flex items-center gap-1.5 text-ui-105 text-[color:var(--color-muted)]">
                  <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                  {encryptionLabel(profile, identity)}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-ui-11 text-[color:var(--color-muted)]">No identity configured. Import or generate a local key, or connect a remote signer below.</p>}

        {identityError ? (
          <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{identityError}</p>
        ) : null}
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Add a local key</h3>
        <p className="mt-1 text-ui-11 text-[color:var(--color-muted)]">Generated keys are saved in the password manager as “Nostr identity” entries, where you can reveal or export the nsec later.</p>
        {identity && !identity.encryptionAvailable ? (
          <p className="mt-2 rounded-lg border border-[color:var(--color-warn)]/25 bg-[color:var(--color-warn)]/10 px-2.5 py-2 text-ui-11 leading-relaxed text-[color:var(--color-warn)]">
            No OS keychain is available, so an imported key will only live in
            memory for this session.
          </p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="nsec1… or 64-char hex" spellCheck={false} autoComplete="off" className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60" />
          <button type="button" disabled={identityBusy || !secret.trim()} onClick={() => void runIdentity(() => window.ncc.importIdentity(secret))} className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40">Import</button>
        </div>
        <button type="button" disabled={identityBusy} onClick={() => void runIdentity(() => window.ncc.generateIdentity())} className="mt-2 text-ui-11 text-[color:var(--color-muted)] underline-offset-2 hover:text-[color:var(--color-text-strong)] hover:underline disabled:opacity-40">
          {identityList.identities.length ? 'Generate another identity' : 'Or generate a new identity'}
        </button>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <input
          type="checkbox"
          checked={ephemeralSigner}
          onChange={(event) => void toggleEphemeralSigner(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
        />
        <span>
          <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
            Use throwaway keys in private and Tor tabs
          </span>
          <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
            NIP-07 uses one generated key shared by private tabs and another shared by Tor
            tabs. Both stay in memory and are discarded when the last tab of that type
            closes. Sites see a different public key; normal tabs keep using your usual
            identity.
          </span>
        </span>
      </label>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex items-center gap-2">
          <Smartphone className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
          <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Remote signer</h3>
        </div>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Connect a bunker such as Amber or Nostr Connect. Signing and private
          locator decryption then happen on the remote device.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={bunker}
            onChange={(event) => setBunker(event.target.value)}
            placeholder="bunker://…"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
          />
          <button
            type="button"
            disabled={connectBusy || bunker.trim().length === 0}
            onClick={() => void connectBunker()}
            className="rounded-lg border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-accent)] disabled:opacity-40"
          >
            {connectBusy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {remoteError ? (
          <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{remoteError}</p>
        ) : null}

        {identity?.mode === 'nip46' && identity.relays?.length ? (
          <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
            <p className="text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
              Bunker relays
            </p>
            <ul className="mt-1.5 space-y-1 font-mono text-ui-11 text-[color:var(--color-text-soft)]">
              {identity.relays.map((url) => (
                <li key={url} className="break-all">
                  {url}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
              A relay listed as <span className="font-mono">ncc://</span> in the bunker
              URL is resolved here, pinned to its locator, and re-resolved before it
              expires.
            </p>
          </div>
        ) : null}
      </div>
    </>
  )
}
