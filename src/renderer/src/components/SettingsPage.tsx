import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  ArrowLeft,
  CircleHelp,
  Copy,
  Globe,
  KeyRound,
  Palette,
  Puzzle,
  RotateCcw,
  Vault,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Trash2
} from 'lucide-react'
import { DEFAULT_APPEARANCE, DEFAULT_RELAYS, DEFAULT_TOR_SOCKS } from '@shared/types'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/search'
import { formatBytes, type CacheInfo } from '@shared/site-data'
import type {
  AppInfo,
  AppearanceConfig,
  HttpsMode,
  IdentityStatus,
  RelayEntry,
  SignerPermission,
  TorMode,
  TorStatus
} from '@shared/types'
import { cn } from '../lib/cn'
import { applyAppearance } from '../lib/appearance'
import { AppearanceSettings } from './AppearanceSettings'
import { AgentSettings } from './AgentSettings'
import { ExtensionSettings } from './ExtensionSettings'
import { PasswordSettings } from './PasswordSettings'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'security'
  | 'identity'
  | 'passwords'
  | 'extensions'
  | 'agent'
  | 'trusted'
  | 'about'

interface SettingsPageProps {
  open: boolean
  initialSection: SettingsSection
  onClose: () => void
  onIdentityChange?: (status: IdentityStatus) => void
  passwordDraftOrigin?: string | null
  onPasswordDraftUsed?: () => void
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof KeyRound }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'identity', label: 'Identity & signer', icon: KeyRound },
  { id: 'passwords', label: 'Passwords', icon: Vault },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'agent', label: 'Agent control', icon: Bot },
  { id: 'trusted', label: 'Trusted services', icon: ShieldCheck },
  { id: 'about', label: 'About', icon: CircleHelp }
]

function CacheRow({
  label,
  bytes,
  value,
  testId
}: {
  label: string
  bytes?: number
  value?: string
  testId?: string
}) {
  return (
    <div
      data-cache-row={testId}
      className="flex items-baseline justify-between gap-2 rounded-lg bg-[color:var(--color-field)] px-2.5 py-1.5"
    >
      <dt className="text-[color:var(--color-muted)]">{label}</dt>
      <dd className="font-mono text-ui-105 text-[color:var(--color-text-soft)]">
        {value ?? formatBytes(bytes ?? 0)}
      </dd>
    </div>
  )
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}

function formatExpiry(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

function shortenIdentity(identity: string): string {
  return identity.length > 26 ? `${identity.slice(0, 16)}…${identity.slice(-6)}` : identity
}

function RelayRow({
  entry,
  onRemove
}: {
  entry: RelayEntry
  onRemove: (url: string) => void
}) {
  const locator = entry.locator
  return (
    <li className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
            entry.stale ? 'bg-[color:var(--color-danger)]' : 'bg-[color:var(--color-ok)]'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-all font-mono text-ui-12 text-[color:var(--color-text)]">{entry.url}</span>
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-ui-10 font-medium',
                locator
                  ? 'border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
              )}
            >
              {locator ? 'Identity' : 'Direct'}
            </span>
            {entry.stale ? (
              <span className="rounded border border-[color:var(--color-danger)]/40 px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-danger)]">
                Stale locator
              </span>
            ) : null}
          </div>
          {locator ? (
            <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
              {shortenIdentity(locator.identity)} · {locator.service} · expires in{' '}
              {formatExpiry(locator.expiresAt)}
              {locator.k ? ` · pin ${locator.k.slice(0, 10)}…` : ' · no pin published'}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={`Remove ${entry.url}`}
          onClick={() => onRemove(entry.url)}
          className="rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  )
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
  onIdentityChange,
  passwordDraftOrigin,
  onPasswordDraftUsed
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const backRef = useRef<HTMLButtonElement>(null)

  const [relayEntries, setRelayEntries] = useState<RelayEntry[]>([])
  const [newRelay, setNewRelay] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)
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
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>('duckduckgo')
  const [searchCustom, setSearchCustom] = useState('')
  const [useOnionSearch, setUseOnionSearch] = useState(true)
  const [appearance, setAppearance] = useState<AppearanceConfig>(DEFAULT_APPEARANCE)
  const [appearanceError, setAppearanceError] = useState<string | null>(null)
  const [historyCleared, setHistoryCleared] = useState(false)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)

  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
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
    setHistoryCleared(false)
    setAppearanceError(null)
    setCacheNotice(null)
    setCacheError(null)
    void Promise.all([
      window.ncc.getConfig(),
      window.ncc.identity(),
      window.ncc.signerPermissions(),
      window.ncc.torStatus(),
      window.ncc.cacheInfo(),
      window.ncc.appInfo()
    ]).then(([config, status, trusted, tor, cacheInfo, about]) => {
      setRelayEntries(config.relays)
      setGossip(config.gossip)
      setAnchorRequired(config.anchorRequired)
      setPreferTor(config.preferTor)
      setTorMode(config.torMode)
      setTorSocks(config.torSocks)
      setTorStatus(tor)
      setHttpsMode(config.httpsMode)
      setWarnInsecure(config.warnInsecure)
      setHttpExceptions(config.httpExceptions ?? [])
      setSearchEngine(config.searchEngine)
      setSearchCustom(config.searchEngineCustom)
      setUseOnionSearch(config.useOnionSearch)
      setAppearance(config.appearance)
      applyAppearance(config.appearance)
      setIdentity(status)
      setPermissions(trusted)
      setCache(cacheInfo)
      setAppInfo(about)
    })
    const frame = window.requestAnimationFrame(() => backRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open, initialSection])

  // A locator-backed relay can rotate while Settings is open. Merge only those
  // entries so unsaved edits to other rows are kept.
  useEffect(() => {
    if (!open) return
    return window.ncc.onConfig((config) => {
      setRelayEntries((current) =>
        current.map((entry) => {
          if (!entry.locator) return entry
          const match = config.relays.find(
            (candidate) =>
              candidate.locator?.identity === entry.locator?.identity &&
              candidate.locator?.service === entry.locator?.service
          )
          return match ?? entry
        })
      )
      if (config.appearance) {
        setAppearance(config.appearance)
        applyAppearance(config.appearance)
      }
    })
  }, [open])

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

  const addRelay = async (): Promise<void> => {
    const value = newRelay.trim()
    if (!value) return
    setError(null)
    setRelayBusy(true)
    try {
      let entry: RelayEntry
      if (/^ncc:\/\//i.test(value)) {
        const outcome = await window.ncc.resolveRelayLocator(value)
        if (!outcome.ok) {
          setError(outcome.error)
          return
        }
        entry = outcome.entry
      } else {
        let url: URL
        try {
          url = new URL(value)
        } catch {
          setError(`Not a valid relay URL: ${value}`)
          return
        }
        if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
          setError('Relays must use ws:// or wss://')
          return
        }
        if (url.hash) {
          setError('Relay URLs cannot contain a fragment')
          return
        }
        entry = { url: url.toString().replace(/\/$/, '') }
      }

      if (relayEntries.some((item) => item.url === entry.url)) {
        setError('That relay is already in the list')
        return
      }

      setRelayEntries([...relayEntries, entry])
      setNewRelay('')
      setSaved(false)
    } finally {
      setRelayBusy(false)
    }
  }

  const removeRelay = (url: string): void => {
    setRelayEntries(relayEntries.filter((entry) => entry.url !== url))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const relayResult = await window.ncc.setRelays(relayEntries)
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
    if (!securityResult.ok) {
      setLoading(false)
      setError(securityResult.error ?? 'Could not save security settings')
      return
    }

    const searchResult = await window.ncc.setSearchConfig({
      engine: searchEngine,
      custom: searchCustom,
      useOnionSearch
    })
    setLoading(false)
    if (!searchResult.ok) {
      setError(searchResult.error ?? 'Could not save search settings')
      return
    }

    const config =
      searchResult.config ??
      securityResult.config ??
      torResult.config ??
      anchorResult.config ??
      gossipResult.config ??
      relayResult.config
    if (config) {
      setRelayEntries(config.relays)
      setGossip(config.gossip)
      setAnchorRequired(config.anchorRequired)
      setPreferTor(config.preferTor)
      setTorMode(config.torMode)
      setTorSocks(config.torSocks)
      setHttpsMode(config.httpsMode)
      setWarnInsecure(config.warnInsecure)
      setHttpExceptions(config.httpExceptions ?? [])
      setSearchEngine(config.searchEngine)
      setSearchCustom(config.searchEngineCustom)
      setUseOnionSearch(config.useOnionSearch)
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

  const changeAppearance = (patch: Partial<AppearanceConfig>): void => {
    // Apply optimistically so theme, size and density change in this frame.
    const next = { ...appearance, ...patch }
    setAppearance(next)
    applyAppearance(next)
    setAppearanceError(null)
    void window.ncc.setAppearance(patch).then((result) => {
      if (!result.ok) {
        setAppearanceError(result.error ?? 'Could not save appearance settings')
        return
      }
      if (result.config?.appearance) {
        setAppearance(result.config.appearance)
        applyAppearance(result.config.appearance)
      }
    })
  }

  const resetAppearance = (): void => {
    changeAppearance(DEFAULT_APPEARANCE)
  }

  const removeHttpException = async (key: string): Promise<void> => {
    const config = await window.ncc.removeHttpException(key)
    setHttpExceptions(config.httpExceptions ?? [])
  }

  const clearHttpExceptions = async (): Promise<void> => {
    const config = await window.ncc.clearHttpExceptions()
    setHttpExceptions(config.httpExceptions ?? [])
  }

  const clearBrowsingHistory = async (): Promise<void> => {
    await window.ncc.clearBrowsingHistory()
    setHistoryCleared(true)
  }

  const clearCache = async (): Promise<void> => {
    setCacheBusy(true)
    setCacheNotice(null)
    setCacheError(null)
    try {
      const before = cache
      const next = await window.ncc.clearCache()
      setCache(next)
      const freed = before ? Math.max(0, before.total - next.total) : 0
      const locators = before?.locators ?? 0
      const suffix = locators > 0 ? ` and ${locators} locator${locators === 1 ? '' : 's'}` : ''
      setCacheNotice(freed > 0 ? `Cleared ${formatBytes(freed)}${suffix}.` : `Cache cleared${suffix}.`)
    } catch (caught) {
      setCacheError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCacheBusy(false)
    }
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
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to browsing
        </button>
        <div className="min-w-0">
          <h1 className="text-ui-13 font-semibold text-[color:var(--color-text-strong)]">Settings</h1>
          <p className="truncate text-ui-105 text-[color:var(--color-muted)]">
            Relays, appearance, identity, passwords, extensions and signing permissions.
          </p>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-105 text-[color:var(--color-muted)]">
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
                    'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-12 transition-colors',
                    active
                      ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-text-strong)]'
                      : 'text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]'
                  )}
                >
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5',
                      active ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-faint)]'
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
                hint="Where NCC-05 locators are looked up. Add a wss:// address or an ncc:// identity."
              />

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <label className="mb-2 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                  Resolution relays
                </label>

                <ul className="space-y-2">
                  {relayEntries.map((entry) => (
                    <RelayRow
                      key={
                        entry.locator
                          ? `${entry.locator.identity}/${entry.locator.service}`
                          : entry.url
                      }
                      entry={entry}
                      onRemove={removeRelay}
                    />
                  ))}
                </ul>

                <div className="mt-3 flex gap-2">
                  <input
                    id="new-relay"
                    value={newRelay}
                    onChange={(event) => {
                      setNewRelay(event.target.value)
                      setError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !relayBusy) {
                        event.preventDefault()
                        void addRelay()
                      }
                    }}
                    placeholder="wss://relay.example or ncc://npub1…/relay"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                  />
                  <button
                    type="button"
                    disabled={relayBusy || newRelay.trim().length === 0}
                    onClick={() => void addRelay()}
                    className="rounded-lg border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-accent)] disabled:opacity-40"
                  >
                    {relayBusy ? 'Resolving…' : 'Add'}
                  </button>
                </div>

                <p className="mt-2 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                  An <span className="font-mono">ncc://</span> relay is resolved from the
                  identity&apos;s NCC-05 locator and re-resolved before it expires. The
                  locator&apos;s <span className="font-mono">k</span> fingerprint is enforced
                  as a TLS pin, so a self-signed relay is accepted only when it matches.
                </p>

                {error ? (
                  <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{error}</p>
                ) : saved ? (
                  <p className="mt-2 text-ui-12 text-[color:var(--color-ok)]">
                    Saved. The resolver and locator cache were cleared.
                  </p>
                ) : (
                  <p className="mt-2 text-ui-12 text-[color:var(--color-muted)]">
                    Defaults: {DEFAULT_RELAYS.join(', ')}
                  </p>
                )}

                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
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
                    <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                      Follow NIP-65 relay hints
                    </span>
                    <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                      Ask the target identity&apos;s relay list where it actually publishes.
                      More reliable, at the cost of one extra metadata lookup on the
                      configured relays.
                    </span>
                  </span>
                </label>

                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
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
                    <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                      Require NCC-02 service records
                    </span>
                    <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                      Fail closed unless the identity publishes a fresh kind 30059 service
                      record with the same service id. When off, NCC-02 is shown as an
                      optional trust anchor.
                    </span>
                  </span>
                </label>

                <div className="mt-4 border-t border-[color:var(--color-line)] pt-4">
                  <div className="flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-[color:var(--color-violet-strong)]" />
                    <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Tor</h3>
                  </div>

                  <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
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
                      <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                        Prefer Tor connections
                      </span>
                      <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                        When a locator publishes an onion endpoint, load the service over Tor
                        instead of its direct endpoints. Records without an onion endpoint
                        load normally.
                      </span>
                    </span>
                  </label>

                  <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
                    <label
                      htmlFor="tor-mode"
                      className="mb-1.5 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
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
                      className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field-alt)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
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
                        className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field-alt)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                      />
                    ) : (
                      <p className="mt-2 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                        Starts the bundled Tor. If it cannot start, the browser tries a local
                        proxy on 127.0.0.1:9050 or 9150.
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p
                        data-tor-status
                        className={cn(
                          'text-ui-11 leading-relaxed',
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
                        className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
                      >
                        {torBusy ? 'Checking…' : 'Test saved connection'}
                      </button>
                    </div>

                    {torStatus?.error ? (
                      <p className="mt-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
                        {torStatus.error}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 border-t border-[color:var(--color-line)] pt-4">
                  <div className="flex items-center gap-2">
                    <Search className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
                    <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Search</h3>
                  </div>

                  <label
                    htmlFor="search-engine"
                    className="mb-1.5 mt-3 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
                  >
                    Search engine
                  </label>
                  <select
                    id="search-engine"
                    value={searchEngine}
                    onChange={(event) => {
                      setSearchEngine(event.target.value as SearchEngineId)
                      setSaved(false)
                    }}
                    className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                  >
                    {SEARCH_ENGINES.map((engine) => (
                      <option key={engine.id} value={engine.id}>
                        {engine.label}
                      </option>
                    ))}
                  </select>

                  {searchEngine === 'searx' ? (
                    <input
                      id="searx-url"
                      value={searchCustom}
                      onChange={(event) => {
                        setSearchCustom(event.target.value)
                        setSaved(false)
                      }}
                      placeholder="https://searx.example"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="SearXNG instance URL"
                      className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                    />
                  ) : null}

                  {searchEngine === 'custom' ? (
                    <input
                      id="search-custom"
                      value={searchCustom}
                      onChange={(event) => {
                        setSearchCustom(event.target.value)
                        setSaved(false)
                      }}
                      placeholder="https://example.com/search?q=%s"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Custom search URL"
                      className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                    />
                  ) : null}

                  <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
                    <input
                      type="checkbox"
                      id="search-onion"
                      checked={useOnionSearch}
                      onChange={(event) => {
                        setUseOnionSearch(event.target.checked)
                        setSaved(false)
                      }}
                      className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
                    />
                    <span>
                      <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                        Use onion search in Tor tabs
                      </span>
                      <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                        DuckDuckGo publishes an onion endpoint; full Tor tabs use it so the
                        search query never leaves the Tor network. Other engines use their
                        normal URL over Tor.
                      </span>
                    </span>
                  </label>

                  <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                    Suggestions come from bookmarks, open tabs and normal-tab history. The
                    browser never asks the engine for suggestions as you type: the query is
                    sent only when you press Enter. Plaintext HTTP search URLs are allowed
                    only for loopback and .onion hosts.
                  </p>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRelayEntries(DEFAULT_RELAYS.map((url) => ({ url })))
                      setAnchorRequired(false)
                      setPreferTor(false)
                      setTorMode('auto')
                      setTorSocks(DEFAULT_TOR_SOCKS)
                      setSearchEngine('duckduckgo')
                      setSearchCustom('')
                      setUseOnionSearch(true)
                      setSaved(false)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset to defaults
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={loading}
                    className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-115 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-60"
                  >
                    {loading ? 'Saving…' : 'Save settings'}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {section === 'appearance' ? (
            <AppearanceSettings
              appearance={appearance}
              onChange={changeAppearance}
              onReset={resetAppearance}
              error={appearanceError}
            />
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
                  className="mb-1.5 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
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
                  className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                >
                  <option value="off">Off — load HTTP normally</option>
                  <option value="prefer">Prefer HTTPS — try HTTPS, then fall back with a warning</option>
                  <option value="only">HTTPS only — never load HTTP without confirmation</option>
                </select>

                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
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
                    <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                      Ask before loading HTTP pages
                    </span>
                    <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                      Show a blocking interstitial before a clearnet HTTP page or an NCC HTTP
                      endpoint. The amber warning bar appears on HTTP pages either way.
                    </span>
                  </span>
                </label>

                <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                  Loopback addresses and <span className="font-mono">.onion</span> services are
                  exempt from automatic HTTPS upgrades. NCC endpoints only use HTTPS when the
                  publisher actually published an HTTPS endpoint.
                </p>

                {error ? (
                  <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{error}</p>
                ) : saved ? (
                  <p className="mt-2 text-ui-12 text-[color:var(--color-ok)]">Saved.</p>
                ) : null}

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void saveSecurity()}
                    disabled={loading}
                    className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-115 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-60"
                  >
                    {loading ? 'Saving…' : 'Save security settings'}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">HTTP exceptions</h3>
                <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                  Origins you have explicitly allowed over HTTP. Private and Tor tab exceptions
                  live only for that session and are not listed here.
                </p>
                {httpExceptions.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {httpExceptions.map((entry) => (
                      <li
                        key={entry}
                        data-http-exception={entry}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-2"
                      >
                        <span className="min-w-0 truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
                          {entry}
                        </span>
                        <button
                          type="button"
                          onClick={() => void removeHttpException(entry)}
                          className="shrink-0 rounded px-1.5 py-0.5 text-ui-105 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                        >
                          remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-ui-11 text-[color:var(--color-muted)]">
                    No HTTP exceptions.
                  </p>
                )}
                {httpExceptions.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void clearHttpExceptions()}
                    className="mt-3 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-ui-11 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                  >
                    Clear all exceptions
                  </button>
                ) : null}
              </div>

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Browsing history</h3>
                <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                  Address-bar suggestions use local bookmarks and normal-tab history. Private
                  and Tor tabs are never recorded. Clearing removes the history file now.
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    data-clear-history
                    onClick={() => void clearBrowsingHistory()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-ui-11 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear browsing history
                  </button>
                  {historyCleared ? (
                    <span className="text-ui-11 text-[color:var(--color-ok)]">Cleared.</span>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Cache</h3>
                <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                  Cached documents, assets and resolved NCC-05 locators. Clearing makes the
                  browser fetch them again, but keeps cookies, sign-ins and site data. Cookies
                  and storage are cleared per site from the padlock.
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-ui-11" data-cache-info>
                  <CacheRow label="Normal tabs" bytes={cache?.normal ?? 0} />
                  <CacheRow label="Private tabs" bytes={cache?.private ?? 0} />
                  <CacheRow label="Tor tabs" bytes={cache?.tor ?? 0} />
                  <CacheRow label="Extension pages" bytes={cache?.extensions ?? 0} />
                  <CacheRow
                    label="Resolved locators"
                    value={`${cache?.locators ?? 0} record${cache?.locators === 1 ? '' : 's'}`}
                    testId="cache-locators"
                  />
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    data-cache-clear
                    disabled={cacheBusy}
                    onClick={() => void clearCache()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" />
                    {cacheBusy ? 'Clearing…' : 'Clear cache'}
                  </button>
                  <span
                    className={cn(
                      'text-ui-11',
                      cacheError
                        ? 'text-[color:var(--color-danger)]'
                        : 'text-[color:var(--color-ok)]'
                    )}
                  >
                    {cacheError ?? cacheNotice}
                  </span>
                </div>
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
                      <span className="inline-flex items-center gap-1.5 text-ui-11 font-medium text-[color:var(--color-accent)]">
                        <Smartphone className="h-3.5 w-3.5" />
                        Remote signer (NIP-46)
                      </span>
                      <button
                        type="button"
                        disabled={identityBusy}
                        onClick={() => void disconnectRemote()}
                        className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
                      >
                        Disconnect
                      </button>
                    </div>
                    <IdentityKey npub={identity.npub} copied={copied} onCopy={() => void copyNpub()} />
                    <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 text-ui-11 text-[color:var(--color-muted)]">
                      <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                      {identity.connected ? 'Connected' : 'Connects on first request'}
                      {identity.persisted ? ' · session encrypted at rest' : ' · session not persisted'}
                    </p>
                    {identity.relays?.length ? (
                      <p className="mt-1 truncate font-mono text-ui-105 text-[color:var(--color-faint)]">
                        {identity.relays.join(' · ')}
                      </p>
                    ) : null}
                  </div>
                ) : identity?.configured ? (
                  <div>
                    <div className="text-ui-11 font-medium text-[color:var(--color-muted)]">
                      Local key
                    </div>
                    <IdentityKey npub={identity.npub} copied={copied} onCopy={() => void copyNpub()} />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-ui-11 text-[color:var(--color-muted)]">
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
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-ui-11 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10 disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove key
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    {identity && !identity.encryptionAvailable ? (
                      <p className="mb-3 rounded-lg border border-[color:var(--color-warn)]/25 bg-[color:var(--color-warn)]/10 px-2.5 py-2 text-ui-11 leading-relaxed text-[color:var(--color-warn)]">
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
                        className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                      />
                      <button
                        type="button"
                        disabled={identityBusy || secret.trim().length === 0}
                        onClick={() => void runIdentity(() => window.ncc.importIdentity(secret))}
                        className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40"
                      >
                        Import
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={identityBusy}
                      onClick={() => void runIdentity(() => window.ncc.generateIdentity())}
                      className="mt-2 text-ui-11 text-[color:var(--color-muted)] underline-offset-2 hover:text-[color:var(--color-text-strong)] hover:underline disabled:opacity-40"
                    >
                      Or generate a new identity
                    </button>
                  </div>
                )}

                {identityError ? (
                  <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{identityError}</p>
                ) : null}
              </div>

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
          ) : null}

          {section === 'passwords' ? (
            <PasswordSettings
              identity={identity}
              draftOrigin={passwordDraftOrigin ?? null}
              onDraftUsed={onPasswordDraftUsed}
              onOpenIdentity={() => setSection('identity')}
            />
          ) : null}

          {section === 'extensions' ? <ExtensionSettings /> : null}

          {section === 'agent' ? <AgentSettings /> : null}

          {section === 'trusted' ? (
            <>
              <SectionHeading
                title="Trusted services"
                hint="Origins that can sign without asking again. Revoke anything you no longer use."
              />
              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-2">
                {permissions.length === 0 ? (
                  <p className="px-3 py-8 text-center text-ui-115 text-[color:var(--color-muted)]">
                    No service has been remembered yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {permissions.map((permission) => (
                      <li
                        key={permission.origin}
                        className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 hover:border-[color:var(--color-line)] hover:bg-[color:var(--color-hover-soft)]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
                            {permission.label}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-ui-95 text-[color:var(--color-faint)]">
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
                          className="shrink-0 rounded p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]"
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

              <div
                data-about-version
                className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                      Nostr Navigator
                    </p>
                    <p className="mt-0.5 font-mono text-ui-115 text-[color:var(--color-text)]">
                      {appInfo ? `v${appInfo.version}` : 'reading version…'}
                    </p>
                  </div>
                  <span className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-muted)]">
                    MIT licence
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-1.5 text-ui-11 sm:grid-cols-2">
                  <AboutRow label="Electron" value={appInfo?.electron} />
                  <AboutRow label="Chromium" value={appInfo?.chromium} />
                  <AboutRow
                    label="Platform"
                    value={appInfo ? `${platformName(appInfo.platform)} ${appInfo.arch}` : undefined}
                  />
                  <AboutRow label="Licence" value="MIT" />
                </dl>

                <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                  Copyright © 2026 imattau. Source, issues and the full licence text live at{' '}
                  <span className="font-mono text-[color:var(--color-text-soft)]">
                    github.com/imattau/ncc-browser
                  </span>
                  .
                </p>
              </div>

              <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                <p>
                  An <span className="font-mono text-[color:var(--color-text)]">ncc://npub…/service</span>{' '}
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
                  className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
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

function platformName(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

function AboutRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-lg bg-[color:var(--color-field)] px-2.5 py-1.5">
      <dt className="text-[color:var(--color-muted)]">{label}</dt>
      <dd className="font-mono text-ui-105 text-[color:var(--color-text-soft)]">{value ?? '—'}</dd>
    </div>
  )
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">{title}</h2>
      <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
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
    <div className="mt-2 flex items-start justify-between gap-2 rounded-lg bg-[color:var(--color-field)] px-2.5 py-2">
      <code className="min-w-0 break-all font-mono text-ui-115 leading-relaxed text-[color:var(--color-text-soft)]">
        {npub}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy npub"
        aria-label="Copy npub"
        className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
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
