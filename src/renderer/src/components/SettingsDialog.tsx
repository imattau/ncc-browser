import { useEffect, useState } from 'react'
import { Copy, KeyRound, RotateCcw, ShieldCheck, Smartphone, Trash2, X } from 'lucide-react'
import { DEFAULT_RELAYS } from '@shared/types'
import type { IdentityStatus, SignerPermission } from '@shared/types'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState('')
  const [gossip, setGossip] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)

  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [permissions, setPermissions] = useState<SignerPermission[]>([])
  const [secret, setSecret] = useState('')
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [bunker, setBunker] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaved(false)
    setIdentityError(null)
    setSecret('')
    setBunker('')
    setRemoteError(null)
    setConnectBusy(false)
    void Promise.all([
      window.ncc.getConfig(),
      window.ncc.identity(),
      window.ncc.signerPermissions()
    ]).then(([config, status, trusted]) => {
      setDraft(config.relays.join('\n'))
      setGossip(config.gossip)
      setIdentity(status)
      setPermissions(trusted)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const save = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const relays = draft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const relayResult = await window.ncc.setRelays(relays)
    if (!relayResult.ok) {
      setLoading(false)
      setError(relayResult.error ?? 'Could not save relays')
      return
    }

    const gossipResult = await window.ncc.setGossip(gossip)
    setLoading(false)
    if (!gossipResult.ok) {
      setError(gossipResult.error ?? 'Could not save gossip setting')
      return
    }

    const config = gossipResult.config ?? relayResult.config
    if (config) {
      setDraft(config.relays.join('\n'))
      setGossip(config.gossip)
    }
    setSaved(true)
  }

  const runIdentity = async (action: () => Promise<IdentityStatus>): Promise<void> => {
    setIdentityBusy(true)
    setIdentityError(null)
    try {
      setIdentity(await action())
      setSecret('')
      setPermissions(await window.ncc.signerPermissions())
    } catch (actionError) {
      setIdentityError(errorMessage(actionError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const copyNpub = async (): Promise<void> => {
    if (!identity?.npub) return
    try {
      await navigator.clipboard.writeText(identity.npub)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // clipboard unavailable
    }
  }

  const connectBunker = async (): Promise<void> => {
    setConnectBusy(true)
    setRemoteError(null)
    try {
      setIdentity(await window.ncc.identityConnectBunker(bunker))
      setBunker('')
      setPermissions(await window.ncc.signerPermissions())
    } catch (connectError) {
      setRemoteError(errorMessage(connectError))
    } finally {
      setConnectBusy(false)
    }
  }

  const disconnectRemote = async (): Promise<void> => {
    setIdentityBusy(true)
    setRemoteError(null)
    try {
      setIdentity(await window.ncc.identityDisconnect())
    } catch (disconnectError) {
      setRemoteError(errorMessage(disconnectError))
    } finally {
      setIdentityBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-16 backdrop-blur-sm">
      <div className="ncc-fade-in w-full max-w-lg rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between border-b border-[color:var(--color-line)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="mt-1 text-xs leading-relaxed text-[color:var(--color-muted)]">
              Resolution relays and the local Nostr identity used for NIP-07 signing.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label
            htmlFor="relays"
            className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]"
          >
            Resolution relays
          </label>
          <textarea
            id="relays"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaved(false)
            }}
            spellCheck={false}
            rows={4}
            className="w-full resize-none rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
          />

          {error ? (
            <p className="mt-2 text-xs text-[color:var(--color-danger)]">{error}</p>
          ) : saved ? (
            <p className="mt-2 text-xs text-[color:var(--color-ok)]">
              Saved. The resolver and locator cache were cleared.
            </p>
          ) : (
            <p className="mt-2 text-xs text-[color:var(--color-muted)]">
              One per line. Defaults: {DEFAULT_RELAYS.join(', ')}
            </p>
          )}

          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3.5">
            <input
              type="checkbox"
              checked={gossip}
              onChange={(event) => {
                setGossip(event.target.checked)
                setSaved(false)
              }}
              className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
            />
            <span>
              <span className="block text-[12px] font-medium text-[#e7e9ef]">
                Follow NIP-65 relay hints
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                Ask the target identity&apos;s relay list where it actually publishes. More
                reliable, at the cost of one extra metadata lookup on the configured relays.
              </span>
            </span>
          </label>

          <div className="mt-5 border-t border-[color:var(--color-line)] pt-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
              <h3 className="text-[12px] font-semibold text-[#e7e9ef]">Identity (NIP-07)</h3>
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
              Pages on <span className="font-mono">ncc://</span> and clearnet can request
              signatures through <span className="font-mono">window.nostr</span>. The secret key
              never leaves the main process.
            </p>

            {identity?.mode === 'nip46' ? (
              <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--color-accent)]">
                    <Smartphone className="h-3.5 w-3.5" />
                    Remote signer (NIP-46)
                  </span>
                  <button
                    type="button"
                    disabled={identityBusy}
                    onClick={() => void disconnectRemote()}
                    className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-[11px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white disabled:opacity-40"
                  >
                    Disconnect
                  </button>
                </div>
                <div className="mt-2 flex items-start justify-between gap-2">
                  <code className="min-w-0 break-all font-mono text-[11.5px] leading-relaxed text-[#c9d1e0]">
                    {identity.npub}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyNpub()}
                    title="Copy npub"
                    className="shrink-0 rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 text-[11px] text-[color:var(--color-muted)]">
                  <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                  {identity.connected ? 'Connected' : 'Connects on first request'}
                  {identity.persisted
                    ? ' · session encrypted at rest'
                    : ' · session not persisted'}
                  {copied ? ' · copied' : ''}
                </p>
                {identity.relays?.length ? (
                  <p className="mt-1 truncate font-mono text-[10.5px] text-[#5d6575]">
                    {identity.relays.join(' · ')}
                  </p>
                ) : null}
              </div>
            ) : identity?.configured ? (
              <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3">
                <div className="flex items-start justify-between gap-2">
                  <code className="min-w-0 break-all font-mono text-[11.5px] leading-relaxed text-[#c9d1e0]">
                    {identity.npub}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyNpub()}
                    title="Copy npub"
                    className="shrink-0 rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted)]">
                    <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                    {identity.source === 'file'
                      ? 'Encrypted with the OS keychain'
                      : identity.source === 'env'
                        ? 'From NCC_IDENTITY_NSEC (development)'
                        : 'This session only'}
                    {copied ? ' · copied' : ''}
                  </span>
                  <button
                    type="button"
                    disabled={identityBusy}
                    onClick={() => void runIdentity(() => window.ncc.removeIdentity())}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-[11px] text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <>
                {identity && !identity.encryptionAvailable ? (
                  <p className="mt-2 rounded-lg border border-[color:var(--color-warn)]/25 bg-[color:var(--color-warn)]/10 px-2.5 py-2 text-[11px] leading-relaxed text-[color:var(--color-warn)]">
                    No OS keychain is available, so an imported key will only live in memory for
                    this session.
                  </p>
                ) : null}

                <div className="mt-3 flex gap-2">
                  <input
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="nsec1… or 64-char hex"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2 font-mono text-[12px] text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
                  />
                  <button
                    type="button"
                    disabled={identityBusy || secret.trim().length === 0}
                    onClick={() => void runIdentity(() => window.ncc.importIdentity(secret))}
                    className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-[11px] font-semibold text-[#0b0c10] disabled:opacity-40"
                  >
                    Import
                  </button>
                </div>

                <button
                  type="button"
                  disabled={identityBusy}
                  onClick={() => void runIdentity(() => window.ncc.generateIdentity())}
                  className="mt-2 text-[11px] text-[color:var(--color-muted)] underline-offset-2 hover:text-white hover:underline disabled:opacity-40"
                >
                  Or generate a new identity
                </button>
              </>
            )}

            {identityError ? (
              <p className="mt-2 text-xs text-[color:var(--color-danger)]">{identityError}</p>
            ) : null}
          </div>

          {permissions.length > 0 ? (
            <div className="mt-5 border-t border-[color:var(--color-line)] pt-4">
              <h3 className="text-[12px] font-semibold text-[#e7e9ef]">Trusted services</h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                These origins can sign without asking again.
              </p>
              <ul className="mt-2 space-y-1.5">
                {permissions.map((permission) => (
                  <li
                    key={permission.origin}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] px-2.5 py-1.5"
                  >
                    <span className="min-w-0 truncate font-mono text-[11px] text-[#c9d1e0]">
                      {permission.label}
                    </span>
                    <button
                      type="button"
                      aria-label={`Revoke ${permission.label}`}
                      onClick={() =>
                        void window.ncc
                          .revokePermission(permission.origin)
                          .then(setPermissions)
                      }
                      className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-[color:var(--color-danger)]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[color:var(--color-line)] px-5 py-3.5">
          <button
            type="button"
            onClick={() => {
              setDraft(DEFAULT_RELAYS.join('\n'))
              setSaved(false)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset relays
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={loading}
              className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-[#0b0c10] disabled:opacity-60"
            >
              {loading ? 'Saving…' : 'Save relays'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
