import { useEffect, useState } from 'react'
import { Check, Copy, EyeOff, KeyRound, Settings2, ShieldCheck, TimerOff } from 'lucide-react'
import { OnionIcon } from './TransportIcons'

interface WelcomeProps {
  onOpenSettings: () => void
  onNewPrivateTab: () => void
  onNewTorTab: () => void
}

const EXAMPLE = 'ncc://npub1…/web'

export function Welcome({ onOpenSettings, onNewPrivateTab, onNewTorTab }: WelcomeProps) {
  const [relays, setRelays] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    void window.ncc.getConfig().then((config) => {
      if (alive) setRelays(config.relays.map((entry) => entry.url))
    })
    return () => {
      alive = false
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-violet)]/10 hover:text-[color:var(--color-violet-text)]"
            >
              <EyeOff className="h-3.5 w-3.5" />
              New private tab
            </button>
            <button
              type="button"
              onClick={onNewTorTab}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-violet)]/10 hover:text-[color:var(--color-violet-text)]"
            >
              <OnionIcon className="h-3.5 w-3.5" />
              New Tor tab
            </button>
          </div>

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
