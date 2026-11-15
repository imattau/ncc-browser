import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  CircleHelp,
  Copy,
  Globe,
  KeyRound,
  RotateCcw,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2
} from 'lucide-react'
import { DEFAULT_RELAYS, DEFAULT_TOR_SOCKS } from '@shared/types'
import type {
  HttpsMode,
  IdentityStatus,
  SignerPermission,
  TorMode,
  TorStatus
} from '@shared/types'
import { cn } from '../lib/cn'

export type SettingsSection = 'general' | 'security' | 'identity' | 'trusted' | 'about'

interface SettingsPageProps {
  open: boolean
  initialSection: SettingsSection
  onClose: () => void
  onIdentityChange?: (status: IdentityStatus) => void
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof KeyRound }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'identity', label: 'Identity & signer', icon: KeyRound },
  { id: 'trusted', label: 'Trusted services', icon: ShieldCheck },
  { id: 'about', label: 'About', icon: CircleHelp }
]

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}

/**
 * Full-page settings, in the spirit of a browser's internal settings page: it lives
 * in the chrome below the toolbar, keeps the tab strip in place, and is closed with
 * the back button or Escape.
 */
export function SettingsPage({
  open,
  initialSection,
  onClose,
  onIdentityChange
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const backRef = useRef<HTMLButtonElement>(null)

  const [draft, setDraft] = useState('')
  const [gossip, setGossip] = useState(true)
  const [anchorRequired, setAnchorRequired] = useState(false)
  const [preferTor, setPreferTor] = useState(false)
  const [torMode, setTorMode] = useState<TorMode>('auto')
  const [torSocks, setTorSocks] = useState(DEFAULT_TOR_SOCKS)
  const [torStatus, setTorStatus] = useState<TorStatus | null>(null)
  const [torBusy, setTorBusy] = useState(false)
  const [httpsMode, setHttpsMode] = useState<HttpsMode>('prefer')
  const [warnInsecure, setWarnInsecure] = useState(false)
  const [httpExceptions, setHttpExceptions] = useState<string[]>([])
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
    setSection(initialSection)
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
      window.ncc.signerPermissions(),
      window.ncc.torStatus()
    ]).then(([config, status, trusted, tor]) => {
      setDraft(config.relays.join('\n'))
      setGossip(config.gossip)
      setAnchorRequired(config.anchorRequired)
      setPreferTor(config.preferTor)
      setTorMode(config.torMode)
      setTorSocks(config.torSocks)
      setTorStatus(tor)
      setHttpsMode(config.httpsMode)
      setWarnInsecure(config.warnInsecure)
      setHttpExceptions(config.httpExceptions ?? [])
      setIdentity(status)
      setPermissions(trusted)
    })
    const frame = window.requestAnimationFrame(() => backRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open, initialSection])

  useEffect(() => {
    if (!open || !torStatus?.starting) return
    const timer = window.setInterval(() => {
      void window.ncc.torStatus().then((status) => {
        setTorStatus(status)
        if (!status.starting) window.clearInterval(timer)
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [open, torStatus?.starting])

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
    if (!gossipResult.ok) {
      setLoading(false)
      setError(gossipResult.error ?? 'Could not save gossip setting')
      return
    }

    const anchorResult = await window.ncc.setAnchorRequired(anchorRequired)
    if (!anchorResult.ok) {
      setLoading(false)
      setError(anchorResult.error ?? 'Could not save anchoring setting')
      return
    }

    const torResult = await window.ncc.setTorConfig({
      preferTor,
      mode: torMode,
      socks: torSocks
    })
    if (!torResult.ok) {
      setLoading(false)
      setError(torResult.error ?? 'Could not save Tor settings')
      return
    }

    const securityResult = await window.ncc.setSecurityConfig({ httpsMode, warnInsecure })
    setLoading(false)
    if (!securityResult.ok) {
      setError(securityResult.error ?? 'Could not save security settings')
      return
    }

    const config =
      securityResult.config ??
      torResult.config ??
      anchorResult.config ??
      gossipResult.config ??
      relayResult.config
    if (config) {
      setDraft(config.relays.join('\n'))
      setGossip(config.gossip)
      setAnchorRequired(config.anchorRequired)
      setPreferTor(config.preferTor)
      setTorMode(config.torMode)
      setTorSocks(config.torSocks)
      setHttpsMode(config.httpsMode)
      setWarnInsecure(config.warnInsecure)
      setHttpExceptions(config.httpExceptions ?? [])
    }
    setTorStatus(await window.ncc.torStatus())
    setSaved(true)
  }

  const saveSecurity = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const result = await window.ncc.setSecurityConfig({ httpsMode, warnInsecure })
    setLoading(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not save security settings')
      return
    }
    if (result.config) {
      setHttpsMode(result.config.httpsMode)
      setWarnInsecure(result.config.warnInsecure)
      setHttpExceptions(result.config.httpExceptions ?? [])
    }
    setSaved(true)
  }

  const removeHttpException = async (key: string): Promise<void> => {
    const config = await window.ncc.removeHttpException(key)
    setHttpExceptions(config.httpExceptions ?? [])
  }

  const clearHttpExceptions = async (): Promise<void> => {
    const config = await window.ncc.clearHttpExceptions()
    setHttpExceptions(config.httpExceptions ?? [])
  }

  const testTor = async (): Promise<void> => {
    setTorBusy(true)
    setError(null)
    try {
      setTorStatus(await window.ncc.torTest())
    } finally {
      setTorBusy(false)
    }
  }

  const runIdentity = async (action: () => Promise<IdentityStatus>): Promise<void> => {
    setIdentityBusy(true)
    setIdentityError(null)
    try {
      const status = await action()
      setIdentity(status)
      onIdentityChange?.(status)
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
      const status = await window.ncc.identityConnectBunker(bunker)
      setIdentity(status)
      onIdentityChange?.(status)
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
      const status = await window.ncc.identityDisconnect()
      setIdentity(status)
      onIdentityChange?.(status)
    } catch (disconnectError) {
      setRemoteError(errorMessage(disconnectError))
    } finally {
      setIdentityBusy(false)
    }
  }

  return (
    <section
      data-settings-page
      aria-label="Settings"
      className="absolute inset-0 z-20 overflow-y-auto bg-[color:var(--color-ink)]"
    >
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-5 py-3">
        <button
          ref={backRef}
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-[11.5px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to browsing
        </button>
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold text-[#e7e9ef]">Settings</h1>
          <p className="truncate text-[10.5px] text-[color:var(--color-muted)]">
            Relays, identity and signing permissions for this browser.
          </p>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-[10.5px] text-[color:var(--color-muted)]">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              identity?.configured
                ? 'bg-[color:var(--color-ok)]'
                : 'bg-[color:var(--color-muted)]/50'
            )}
          />
          {identity?.mode === 'nip46'
            ? 'Remote signer'
            : identity?.configured
              ? 'Local key'
              : 'No identity'}
        </span>
      </header>

      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-7 md:flex-row md:px-7">
        <nav aria-label="Settings sections" className="shrink-0 md:w-[190px]">
          <div className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((entry) => {
              const Icon = entry.icon
              const active = entry.id === section
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-settings-section={entry.id}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setSection(entry.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors',
                    active
                      ? 'bg-[color:var(--color-accent)]/10 text-[#e7e9ef]'
                      : 'text-[color:var(--color-muted)] hover:bg-white/[0.05] hover:text-white'
                  )}
                >
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5',
                      active ? 'text-[color:var(--color-accent)]' : 'text-[#5d6575]'
                    )}
                  />
                  {entry.label}
                </button>
              )
            })}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {section === 'general' ? (
            <>
              <SectionHeading
                title="Relays & resolution"
                hint="Where NCC-05 locators are looked up. One relay per line."
              />

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <label
                  htmlFor="relays"
                  className="mb-2 block text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
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
                  rows={5}
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
                    Defaults: {DEFAULT_RELAYS.join(', ')}
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
                      Ask the target identity&apos;s relay list where it actually publishes.
                      More reliable, at the cost of one extra metadata lookup on the
                      configured relays.
                    </span>
                  </span>
                </label>

                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3.5">
                  <input
                    type="checkbox"
                    id="anchor-required"
                    checked={anchorRequired}
                    onChange={(event) => {
                      setAnchorRequired(event.target.checked)
                      setSaved(false)
                    }}
                    className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
                  />
                  <span>
                    <span className="block text-[12px] font-medium text-[#e7e9ef]">
                      Require NCC-02 service records
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                      Fail closed unless the identity publishes a fresh kind 30059 service
                      record with the same service id. When off, NCC-02 is shown as an
                      optional trust anchor.
                    </span>
                  </span>
                </label>

                <div className="mt-4 border-t border-[color:var(--color-line)] pt-4">
                  <div className="flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-[#a78bfa]" />
                    <h3 className="text-[12px] font-semibold text-[#e7e9ef]">Tor</h3>
                  </div>

                  <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3.5">
                    <input
                      type="checkbox"
                      id="prefer-tor"
                      checked={preferTor}
                      onChange={(event) => {
                        setPreferTor(event.target.checked)
                        setSaved(false)
                      }}
                      className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
                    />
                    <span>
                      <span className="block text-[12px] font-medium text-[#e7e9ef]">
                        Prefer Tor connections
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                        When a locator publishes an onion endpoint, load the service over Tor
                        instead of its direct endpoints. Records without an onion endpoint
                        load normally.
                      </span>
                    </span>
                  </label>

                  <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3.5">
                    <label
                      htmlFor="tor-mode"
                      className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
                    >
                      Tor proxy
                    </label>
                    <select
                      id="tor-mode"
                      value={torMode}
                      onChange={(event) => {
                        setTorMode(event.target.value === 'local' ? 'local' : 'auto')
                        setSaved(false)
                      }}
                      className="w-full rounded-xl border border-[color:var(--color-line)] bg-[#14161d] px-3 py-2 text-[12px] text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
                    >
                      <option value="auto">Automatic (bundled Tor, then local)</option>
                      <option value="local">Local SOCKS proxy</option>
                    </select>

                    {torMode === 'local' ? (
                      <input
                        value={torSocks}
                        onChange={(event) => {
                          setTorSocks(event.target.value)
                          setSaved(false)
                        }}
                        placeholder={DEFAULT_TOR_SOCKS}
                        spellCheck={false}
                        autoComplete="off"
                        aria-label="Tor SOCKS proxy"
                        className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[#14161d] px-3 py-2 font-mono text-[12px] text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
                      />
                    ) : (
                      <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--color-muted)]">
                        Starts the bundled Tor. If it cannot start, the browser tries a local
                        proxy on 127.0.0.1:9050 or 9150.
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p
                        data-tor-status
                        className={cn(
                          'text-[11px] leading-relaxed',
                          torStatus?.error
                            ? 'text-[color:var(--color-warn)]'
                            : 'text-[color:var(--color-muted)]'
                        )}
                      >
                        {torStatusText(torStatus)}
                      </p>
                      <button
                        type="button"
                        disabled={torBusy || loading}
                        onClick={() => void testTor()}
                        className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-[11px] text-[#dfe3ea] hover:bg-white/5 disabled:opacity-40"
                      >
                        {torBusy ? 'Checking…' : 'Test saved connection'}
                      </button>
                    </div>

                    {torStatus?.error ? (
                      <p className="mt-2 text-[10.5px] leading-relaxed text-[color:var(--color-warn)]">
                        {torStatus.error}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(DEFAULT_RELAYS.join('\n'))
                      setAnchorRequired(false)
                      setPreferTor(false)
                      setTorMode('auto')
                      setTorSocks(DEFAULT_TOR_SOCKS)
                      setSaved(false)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset to defaults
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={loading}
                    className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-[11.5px] font-semibold text-[#0b0c10] disabled:opacity-60"
                  >
                    {loading ? 'Saving…' : 'Save settings'}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {section === 'security' ? (
            <>
              <SectionHeading
                title="Secure connections"
                hint="Prefer or require HTTPS, and decide how plaintext HTTP is warned about."
              />

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <label
                  htmlFor="https-mode"
                  className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
                >
                  HTTPS policy
                </label>
                <select
                  id="https-mode"
                  value={httpsMode}
                  onChange={(event) => {
                    setHttpsMode(
                      event.target.value === 'off'
                        ? 'off'
                        : event.target.value === 'only'
                          ? 'only'
                          : 'prefer'
                    )
                    setSaved(false)
                  }}
                  className="w-full rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2 text-[12px] text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
                >
                  <option value="off">Off — load HTTP normally</option>
                  <option value="prefer">Prefer HTTPS — try HTTPS, then fall back with a warning</option>
                  <option value="only">HTTPS only — never load HTTP without confirmation</option>
                </select>

                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3.5">
                  <input
                    type="checkbox"
                    id="warn-insecure"
                    checked={warnInsecure}
                    onChange={(event) => {
                      setWarnInsecure(event.target.checked)
                      setSaved(false)
                    }}
                    className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
                  />
                  <span>
                    <span className="block text-[12px] font-medium text-[#e7e9ef]">
                      Ask before loading HTTP pages
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                      Show a blocking interstitial before a clearnet HTTP page or an NCC HTTP
                      endpoint. The amber warning bar appears on HTTP pages either way.
                    </span>
                  </span>
                </label>

                <p className="mt-3 text-[11px] leading-relaxed text-[color:var(--color-muted)]">
                  Loopback addresses and <span className="font-mono">.onion</span> services are
                  exempt from automatic HTTPS upgrades. NCC endpoints only use HTTPS when the
                  publisher actually published an HTTPS endpoint.
                </p>

                {error ? (
                  <p className="mt-2 text-xs text-[color:var(--color-danger)]">{error}</p>
                ) : saved ? (
                  <p className="mt-2 text-xs text-[color:var(--color-ok)]">Saved.</p>
                ) : null}

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void saveSecurity()}
                    disabled={loading}
                    className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-[11.5px] font-semibold text-[#0b0c10] disabled:opacity-60"
                  >
                    {loading ? 'Saving…' : 'Save security settings'}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <h3 className="text-[12px] font-semibold text-[#e7e9ef]">HTTP exceptions</h3>
                <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                  Origins you have explicitly allowed over HTTP. Private and Tor tab exceptions
                  live only for that session and are not listed here.
                </p>
                {httpExceptions.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {httpExceptions.map((entry) => (
                      <li
                        key={entry}
                        data-http-exception={entry}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] px-2.5 py-2"
                      >
                        <span className="min-w-0 truncate font-mono text-[11px] text-[#c9d1e0]">
                          {entry}
                        </span>
                        <button
                          type="button"
                          onClick={() => void removeHttpException(entry)}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                        >
                          remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-[11px] text-[color:var(--color-muted)]">
                    No HTTP exceptions.
                  </p>
                )}
                {httpExceptions.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void clearHttpExceptions()}
                    className="mt-3 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-[11px] text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                  >
                    Clear all exceptions
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {section === 'identity' ? (
            <>
              <SectionHeading
                title="Identity (NIP-07)"
                hint="Pages on ncc:// and clearnet can request signatures through window.nostr. The secret key never leaves the main process."
              />

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                {identity?.mode === 'nip46' ? (
                  <div>
                    <div className="flex items-start justify-between gap-3">
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
                    <IdentityKey npub={identity.npub} copied={copied} onCopy={() => void copyNpub()} />
                    <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 text-[11px] text-[color:var(--color-muted)]">
                      <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                      {identity.connected ? 'Connected' : 'Connects on first request'}
                      {identity.persisted ? ' · session encrypted at rest' : ' · session not persisted'}
                    </p>
                    {identity.relays?.length ? (
                      <p className="mt-1 truncate font-mono text-[10.5px] text-[#5d6575]">
                        {identity.relays.join(' · ')}
                      </p>
                    ) : null}
                  </div>
                ) : identity?.configured ? (
                  <div>
                    <div className="text-[11px] font-medium text-[color:var(--color-muted)]">
                      Local key
                    </div>
                    <IdentityKey npub={identity.npub} copied={copied} onCopy={() => void copyNpub()} />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted)]">
                        <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                        {identity.source === 'file'
                          ? 'Encrypted with the OS keychain'
                          : identity.source === 'env'
                            ? 'From NCC_IDENTITY_NSEC (development)'
                            : 'This session only'}
                      </span>
                      <button
                        type="button"
                        disabled={identityBusy}
                        onClick={() => void runIdentity(() => window.ncc.removeIdentity())}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-[11px] text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10 disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove key
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    {identity && !identity.encryptionAvailable ? (
                      <p className="mb-3 rounded-lg border border-[color:var(--color-warn)]/25 bg-[color:var(--color-warn)]/10 px-2.5 py-2 text-[11px] leading-relaxed text-[color:var(--color-warn)]">
                        No OS keychain is available, so an imported key will only live in
                        memory for this session.
                      </p>
                    ) : null}

                    <div className="flex gap-2">
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
                  </div>
                )}

                {identityError ? (
                  <p className="mt-2 text-xs text-[color:var(--color-danger)]">{identityError}</p>
                ) : null}
              </div>

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
                  <h3 className="text-[12px] font-semibold text-[#e7e9ef]">Remote signer</h3>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
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
                    className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2 font-mono text-[12px] text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
                  />
                  <button
                    type="button"
                    disabled={connectBusy || bunker.trim().length === 0}
                    onClick={() => void connectBunker()}
                    className="rounded-lg border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--color-accent)] disabled:opacity-40"
                  >
                    {connectBusy ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
                {remoteError ? (
                  <p className="mt-2 text-xs text-[color:var(--color-danger)]">{remoteError}</p>
                ) : null}
              </div>
            </>
          ) : null}

          {section === 'trusted' ? (
            <>
              <SectionHeading
                title="Trusted services"
                hint="Origins that can sign without asking again. Revoke anything you no longer use."
              />
              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-2">
                {permissions.length === 0 ? (
                  <p className="px-3 py-8 text-center text-[11.5px] text-[color:var(--color-muted)]">
                    No service has been remembered yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {permissions.map((permission) => (
                      <li
                        key={permission.origin}
                        className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 hover:border-[color:var(--color-line)] hover:bg-white/[0.03]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[11px] text-[#c9d1e0]">
                            {permission.label}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-[#5d6575]">
                            {permission.origin}
                          </span>
                        </span>
                        <button
                          type="button"
                          aria-label={`Revoke ${permission.label}`}
                          onClick={() =>
                            void window.ncc
                              .revokePermission(permission.origin)
                              .then(setPermissions)
                          }
                          className="shrink-0 rounded p-1.5 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-[color:var(--color-danger)]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : null}

          {section === 'about' ? (
            <>
              <SectionHeading
                title="About Nostr Navigator"
                hint="A browser that resolves services through signed Nostr locators instead of DNS."
              />
              <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                <p>
                  An <span className="font-mono text-[#dfe3ea]">ncc://npub…/service</span>{' '}
                  address is resolved through NCC-05: the npub signs a locator that lists
                  endpoints and, optionally, a TLS SPKI fingerprint. No DNS and no
                  certificate authority are involved.
                </p>
                <p>
                  The address bar shows the npub address you asked for. The endpoint
                  host and port stay out of the UI.
                </p>
                <p>
                  Bundled Tor is distributed under its own BSD licence; the licence and
                  source notice ship in the app&apos;s resources.
                </p>
                <button
                  type="button"
                  onClick={() => void window.ncc.runCommand('open-spec')}
                  className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-[11.5px] text-[#dfe3ea] hover:bg-white/5"
                >
                  Read the NCC-05 specification
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function torStatusText(status: TorStatus | null): string {
  if (!status) return 'Tor has not been started.'
  if (status.starting) return 'Starting Tor…'
  if (status.ready && status.proxy) {
    return `${status.kind === 'bundled' ? 'Bundled Tor' : 'Local Tor'} ready on ${status.proxy}`
  }
  if (status.error) return 'Tor is unavailable.'
  return 'Tor starts automatically when an onion service is opened.'
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold text-[#e7e9ef]">{title}</h2>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
        {hint}
      </p>
    </div>
  )
}

function IdentityKey({
  npub,
  copied,
  onCopy
}: {
  npub?: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="mt-2 flex items-start justify-between gap-2 rounded-lg bg-[#0e1016] px-2.5 py-2">
      <code className="min-w-0 break-all font-mono text-[11.5px] leading-relaxed text-[#c9d1e0]">
        {npub}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy npub"
        aria-label="Copy npub"
        className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
      >
        {copied ? (
          <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  )
}
