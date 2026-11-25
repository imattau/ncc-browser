import { useEffect, useState } from 'react'
import { AppWindow, Check, Copy, EyeOff, Globe, KeyRound, Server, Settings2, ShieldCheck, TimerOff, X } from 'lucide-react'
import type { TabKind } from '@shared/types'
import { normalizeHomeSite, type HomeSite } from '@shared/home-sites'
import { recipientNpub, serviceAddress, type HostedService } from '@shared/hosting'
import { cn } from '../lib/cn'
import { TAB_KIND_SUMMARY, TAB_KIND_TONE } from '../lib/tab-kind'
import { OnionIcon } from './TransportIcons'

interface WelcomeProps {
  onOpenSettings: () => void
  onOpenServices: () => void
  onNewPrivateTab: () => void
  onNewTorTab: () => void
  kind?: TabKind
}

const EXAMPLE = 'ncc://npub1…/web'

export function Welcome({ onOpenSettings, onOpenServices, onNewPrivateTab, onNewTorTab, kind = 'normal' }: WelcomeProps) {
  const [relays, setRelays] = useState<string[]>([])
  const [services, setServices] = useState<HostedService[]>([])
  const [npub, setNpub] = useState('')
  const [copied, setCopied] = useState(false)
  const [homeSites, setHomeSites] = useState<HomeSite[]>(() => readHomeSites())

  useEffect(() => {
    const refresh = (): void => setHomeSites(readHomeSites())
    window.addEventListener('ncc:home-sites-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('ncc:home-sites-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const removeHomeSite = (url: string): void => {
    const next = homeSites.filter((site) => site.url !== url)
    localStorage.setItem('ncc.home-sites', JSON.stringify(next))
    setHomeSites(next)
  }

  useEffect(() => {
    let alive = true
    void window.ncc.getConfig().then((config) => {
      if (alive) setRelays(config.relays.map((entry) => entry.url))
    })
    void window.ncc.hostingState().then((state) => {
      if (alive) setServices(state.services)
    }).catch(() => {})
    const off = window.ncc.onHostingChanged((state) => {
      if (alive) setServices(state.services)
    })
    void window.ncc.identity().then((status) => {
      if (!alive) return
      setNpub(status.npub ?? (status.hexPubkey ? recipientNpub(status.hexPubkey) : ''))
    }).catch(() => {})
    return () => {
      alive = false
      off()
    }
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(EXAMPLE)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[radial-gradient(1100px_480px_at_50%_-15%,rgba(138,180,255,0.16),transparent_62%)]">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-10 py-14">
        <div className="ncc-fade-in">
          {kind !== 'normal' ? (
            <div
              data-kind-notice={kind}
              role="note"
              className={cn(
                'mb-6 flex items-start gap-3 rounded-xl border px-4 py-3',
                TAB_KIND_TONE[kind].border,
                TAB_KIND_TONE[kind].soft
              )}
            >
              {kind === 'tor' ? (
                <OnionIcon className={cn('mt-0.5 h-5 w-5 shrink-0', TAB_KIND_TONE.tor.text)} />
              ) : (
                <EyeOff className={cn('mt-0.5 h-5 w-5 shrink-0', TAB_KIND_TONE.private.text)} />
              )}
              <div>
                <p className={cn('text-ui-135 font-semibold', TAB_KIND_TONE[kind].text)}>
                  {kind === 'tor' ? 'You are in a Tor tab' : 'You are in a private tab'}
                </p>
                <p className="mt-0.5 text-ui-12 text-[color:var(--color-muted)]">
                  {TAB_KIND_SUMMARY[kind]}
                </p>
              </div>
            </div>
          ) : null}
          <span className="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-3 py-1 text-ui-11 font-medium tracking-wide text-[color:var(--color-accent)]">
            NCC-05 · identity-bound resolution
          </span>

          <h1 className="mt-6 text-ui-42 font-semibold leading-[1.05] tracking-[-0.03em]">
            No DNS.
            <br />
            <span className="text-[color:var(--color-accent)]">Just keys.</span>
          </h1>

          <p className="mt-5 max-w-xl text-ui-15 leading-relaxed text-[color:var(--color-muted)]">
            Type an <span className="text-[color:var(--color-text)]">ncc://</span> address to find a service the
            way its owner signed it: by <span className="text-[color:var(--color-text)]">npub</span>, not by
            hostname. The locator is fetched from Nostr relays, decrypted if needed, and expired
            records are refused.
          </p>

          <div className="mt-8 flex items-center gap-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-4 py-3">
            <code className="flex-1 font-mono text-ui-135 text-[color:var(--color-text-soft)]">{EXAMPLE}</code>
            <button
              type="button"
              onClick={() => void copy()}
              title="Copy example address"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'copied' : 'copy'}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onNewPrivateTab}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-private)]/12 hover:text-[color:var(--color-private-text)]"
            >
              <EyeOff className="h-3.5 w-3.5" />
              New private tab
            </button>
            <button
              type="button"
              onClick={onNewTorTab}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-tor)]/12 hover:text-[color:var(--color-tor-text)]"
            >
              <OnionIcon className="h-3.5 w-3.5" />
              New Tor tab
            </button>
          </div>

          {kind === 'normal' && homeSites.length > 0 ? (
            <section className="mt-8 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel)]/70 p-3.5">
              <h2 className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                <AppWindow className="h-3.5 w-3.5 text-[color:var(--color-accent)]" /> Home screen
              </h2>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {homeSites.map((site) => (
                  <div key={site.url} className="flex min-w-0 items-center gap-1 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)]">
                    <button type="button" onClick={() => void window.ncc.navigate(site.url)} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left hover:bg-[color:var(--color-hover)]">
                      {site.icon ? <img src={site.icon} alt="" className="h-5 w-5 rounded" /> : <Globe className="h-4 w-4 shrink-0 text-[color:var(--color-accent)]" />}
                      <span className="truncate text-ui-11 text-[color:var(--color-text)]">{site.title}</span>
                    </button>
                    <button type="button" aria-label={`Remove ${site.title} from home screen`} title="Remove" onClick={() => removeHomeSite(site.url)} className="rounded p-1.5 text-[color:var(--color-faint)] hover:text-[color:var(--color-danger)]">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {services.length > 0 ? (
            <div className="mt-8 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel)]/70 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                  <Server className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
                  Your services
                </h2>
                <button
                  type="button"
                  onClick={onOpenServices}
                  className="rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
                >
                  Manage
                </button>
              </div>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {services.slice(0, 4).map((service) => {
                  const serviceNpub = service.owner ? recipientNpub(service.owner) : npub
                  const address = serviceNpub ? serviceAddress(serviceNpub, service.service) : ''
                  return (
                    <button
                      key={service.id}
                      type="button"
                      disabled={!address}
                      onClick={() => address && void window.ncc.navigate(address)}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-2 text-left hover:border-[color:var(--color-accent)]/40 disabled:opacity-50"
                    >
                      <span className="truncate text-ui-11 text-[color:var(--color-text)]">{service.title}</span>
                      <span className="shrink-0 text-ui-95 text-[color:var(--color-faint)]">
                        {service.lastPublishedAt ? 'published' : 'not published'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="mt-8 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={onOpenServices}
                className="flex w-full items-center gap-3 rounded-xl border border-dashed border-[color:var(--color-line)] px-4 py-3 text-left hover:border-[color:var(--color-accent)]/40 hover:bg-[color:var(--color-hover-soft)]"
              >
                <Server className="h-4 w-4 shrink-0 text-[color:var(--color-accent)]" />
                <span className="min-w-0">
                  <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                    Publish a service you run
                  </span>
                  <span className="block text-ui-105 text-[color:var(--color-muted)]">
                    Give it an npub address, then share it privately with the people you choose.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void window.ncc.runCommand('open-site-publisher')}
                className="flex w-full items-center gap-3 rounded-xl border border-dashed border-[color:var(--color-line)] px-4 py-3 text-left hover:border-[color:var(--color-accent)]/40 hover:bg-[color:var(--color-hover-soft)]"
              >
                <Globe className="h-4 w-4 shrink-0 text-[color:var(--color-accent)]" />
                <span className="min-w-0">
                  <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                    Publish a static site
                  </span>
                  <span className="block text-ui-105 text-[color:var(--color-muted)]">
                    Files on Blossom, a signed manifest, no host: nsite://&lt;you&gt;/&lt;site&gt;.
                  </span>
                </span>
              </button>
            </div>
          )}

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <Fact
              icon={<KeyRound className="h-4 w-4" />}
              title="The npub is the origin"
              body="A locator is only honoured if it is signed by the key in the address."
            />
            <Fact
              icon={<TimerOff className="h-4 w-4" />}
              title="Records expire"
              body="TTL is enforced, never extended. A stale locator is an error, not a guess."
            />
            <Fact
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Transport is pinned"
              body="When the record carries a k fingerprint, the TLS certificate must match it."
            />
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-line)] pt-5 text-ui-12 text-[color:var(--color-muted)]">
            <span>
              {relays.length > 0
                ? `Resolving on ${relays.length} relay${relays.length === 1 ? '' : 's'}: ${relays.join(' · ')}`
                : 'Loading relay configuration…'}
            </span>
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Change relays
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function readHomeSites(): HomeSite[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem('ncc.home-sites') || '[]')
    return Array.isArray(values) ? values.map(normalizeHomeSite).filter((site): site is HomeSite => site !== null) : []
  } catch {
    return []
  }
}

interface FactProps {
  icon: React.ReactNode
  title: string
  body: string
}

function Fact({ icon, title, body }: FactProps) {
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel)]/70 p-3.5">
      <div className="flex items-center gap-2 text-[color:var(--color-accent)]">
        {icon}
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">{title}</h3>
      </div>
      <p className="mt-1.5 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">{body}</p>
    </div>
  )
}
