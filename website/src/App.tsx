import { useEffect, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Github,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Menu,
  MonitorSmartphone,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
  Zap
} from 'lucide-react'
import { NRelay1 } from '@nostrify/nostrify'

const REPO = 'https://github.com/imattau/ncc-browser'
const RELEASES = `${REPO}/releases/latest`
const GIT_MIRROR =
  'https://gitworkshop.dev/npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q/relay.ngit.dev/nostr-navigator'
const NOSTRHUB =
  'https://nostrhub.io/npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q/nostr-navigator'
const DOCS = `${REPO}/tree/main/docs`
const SPEC = 'https://github.com/imattau/nostr-community-conventions'
const NPACK = 'https://github.com/imattau/npack'
const PUBLISHER_NPUB = 'npub1g3vdg46zq7xpkmtdnta7l8u9684zd2p4e9wrp3xd7wv4xk7vq03svh653x'
const SITE_NPUB = 'npub15d7l6vky77x34wu2rl2jdlafmpuycjsca06sjpmqgc7ggnd0zazsja3gma'
const CONTACT_NPUB = 'npub15d7l6vky77x34wu2rl2jdlafmpuycjsca06sjpmqgc7ggnd0zazsja3gma'
const WHITE_NOISE_CONTACT = `whitenoise://user/${CONTACT_NPUB}`
const PUBLISHER_HEX = '4458d45742078c1b6d6d9afbef9f85d1ea26a835c95c30c4cdf399535bcc03e3'
const FALLBACK_VERSION = '0.47.10'
const NPACK_COMMAND = `npack install ${PUBLISHER_NPUB}/ncc-browser`

interface Release {
  version: string
  npkUrl: string
  eventId: string
}

function useLatestRelease(): Release | null {
  const [release, setRelease] = useState<Release | null>(null)

  useEffect(() => {
    let alive = true
    const relays = ['wss://relay.ditto.pub', 'wss://relay.primal.net', 'wss://nos.lol']
    void Promise.allSettled(
      relays.map(async (url) => {
        const relay = new NRelay1(url)
        try {
          return await relay.query(
            [{ kinds: [1063], authors: [PUBLISHER_HEX], limit: 30 }],
            { signal: AbortSignal.timeout(6000) }
          )
        } finally {
          relay.close()
        }
      })
    )
      .then((results) => {
        if (!alive) return
        const events = results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : []
        )
        const candidates = events
          .filter((event) => event.content === 'ncc-browser')
          .sort((a, b) => b.created_at - a.created_at)
        for (const event of candidates) {
          const url = event.tags.find((tag) => tag[0] === 'url')?.[1]
          const version = url?.match(/\/download\/v([^/]+)\//)?.[1]
          if (url && version) {
            setRelease({ version, npkUrl: url, eventId: event.id })
            return
          }
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return release
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-muted transition hover:text-text"
    >
      {copied ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-medium tracking-wide text-accent">
      {children}
    </span>
  )
}

function SectionHeading({
  eyebrow,
  title,
  intro
}: {
  eyebrow: string
  title: string
  intro?: string
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-text sm:text-4xl">{title}</h2>
      {intro ? <p className="mt-4 text-[15px] leading-relaxed text-muted">{intro}</p> : null}
    </div>
  )
}

function Feature({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="glass rounded-2xl p-5 transition hover:border-accent/30">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-panel-2 text-accent">
        {icon}
      </div>
      <h3 className="mt-4 text-[14px] font-semibold text-text">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{children}</p>
    </div>
  )
}

function PlatformCard({
  icon,
  name,
  detail,
  files,
  href
}: {
  icon: React.ReactNode
  name: string
  detail: string
  files: string
  href: string
}) {
  return (
    <a
      href={href}
      className="glass group flex flex-col rounded-2xl p-5 transition hover:border-accent/40 hover:bg-panel-2"
    >
      <div className="flex items-center justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-panel-2 text-accent">
          {icon}
        </div>
        <ArrowRight className="h-4 w-4 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </div>
      <h3 className="mt-4 text-[14px] font-semibold text-text">{name}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{detail}</p>
      <p className="mt-3 font-mono text-[10px] text-faint">{files}</p>
    </a>
  )
}

function CodeChip({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] text-text-soft">
      {children}
    </code>
  )
}

const FEATURES = [
  {
    icon: <Globe className="h-4 w-4" />,
    title: 'Services by identity',
    body: 'Open ncc://<npub>/<service>. A signed NCC-05 locator points at the current endpoint, with optional TLS pinning. No DNS, registrar or certificate authority in the path.'
  },
  {
    icon: <FileCode2 className="h-4 w-4" />,
    title: 'Sites without a host',
    body: 'Publish a static folder as a NIP-5A site. The manifest is signed, files live on Blossom, and every byte is checked against its sha256 before it renders.'
  },
  {
    icon: <KeyRound className="h-4 w-4" />,
    title: 'A signer, built in',
    body: 'window.nostr works without an extension on ncc:// and clearnet pages. Use a local key or a NIP-46 remote signer, with per-service approvals.'
  },
  {
    icon: <Lock className="h-4 w-4" />,
    title: 'Private by default',
    body: 'Suggestions stay local, private tabs use an in-memory session, and Tor tabs route page traffic and relay lookups through Tor. No vendor account required.'
  },
  {
    icon: <Sparkles className="h-4 w-4" />,
    title: 'Publish from the browser',
    body: 'Turn a local service into ncc://…, share it privately with the people you choose, or publish a static site to nsite://… — all from Settings.'
  },
  {
    icon: <MonitorSmartphone className="h-4 w-4" />,
    title: 'Linux, macOS, Windows, Android',
    body: 'Desktop builds for the three major platforms and an Android alpha. Your bookmarks, tabs and history can sync encrypted over Nostr.'
  }
] as const

export function App() {
  const release = useLatestRelease()
  const version = release?.version ?? FALLBACK_VERSION
  const npkUrl = release?.npkUrl ?? RELEASES
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[720px] grid-lines" />

      <header className="sticky top-0 z-40 border-b border-line/70 bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3 sm:px-8">
          <a href="#top" className="flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="h-8 w-8" />
            <span className="text-[13px] font-semibold tracking-tight text-text">Nostr Navigator</span>
          </a>
          <nav className="ml-auto hidden items-center gap-6 text-[12px] text-muted sm:flex">
            <a href="#features" className="hover:text-text">Features</a>
            <a href="#how" className="hover:text-text">How it works</a>
            <a href="#publish" className="hover:text-text">Publish</a>
            <a href="#download" className="hover:text-text">Download</a>
            <a href={DOCS} className="hover:text-text">Docs</a>
            <a href={WHITE_NOISE_CONTACT} className="inline-flex items-center gap-1.5 hover:text-text">
              <img src="/whitenoise-logo.svg" alt="" className="h-3.5 w-3.5 rounded-sm" /> Message us on White Noise
            </a>
          </nav>
          <a
            href={REPO}
            className="ml-auto hidden items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[12px] text-text transition hover:border-accent/40 sm:ml-0 sm:inline-flex"
          >
            <Github className="h-3.5 w-3.5" /> GitHub
          </a>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted sm:hidden"
            aria-label="Toggle menu"
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
        {menuOpen ? (
          <nav className="border-t border-line px-5 py-3 text-[13px] text-muted sm:hidden">
            <div className="flex flex-col gap-2">
              <a href="#features" onClick={() => setMenuOpen(false)}>Features</a>
              <a href="#how" onClick={() => setMenuOpen(false)}>How it works</a>
              <a href="#publish" onClick={() => setMenuOpen(false)}>Publish</a>
              <a href="#download" onClick={() => setMenuOpen(false)}>Download</a>
              <a href={DOCS}>Docs</a>
              <a href={WHITE_NOISE_CONTACT} onClick={() => setMenuOpen(false)} className="inline-flex items-center gap-1.5">
                <img src="/whitenoise-logo.svg" alt="" className="h-3.5 w-3.5 rounded-sm" /> Message us on White Noise
              </a>
            </div>
          </nav>
        ) : null}
      </header>

      <main id="top">
        <section className="relative mx-auto max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1.02fr_1fr]">
            <div>
              <Badge>
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                v{version} · Nostr-native browser
              </Badge>
              <h1 className="mt-6 text-[52px] font-semibold leading-[0.98] tracking-[-0.045em] text-text sm:text-[72px]">
                No DNS.
                <br />
                <span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">
                  Just keys.
                </span>
              </h1>
              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-muted sm:text-[16px]">
                A cross-platform browser that resolves services and static sites by Nostr
                identity instead of DNS. Open <CodeChip>ncc://npub…/photos</CodeChip> or{' '}
                <CodeChip>nsite://npub…/blog</CodeChip> — no domain, certificate or platform
                account in the path.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a
                  href={RELEASES}
                  className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-ink transition hover:bg-accent-2"
                >
                  <Download className="h-4 w-4" /> Download latest
                </a>
                <a
                  href={DOCS}
                  className="inline-flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-2.5 text-[13px] text-text transition hover:border-accent/40"
                >
                  <BookOpen className="h-4 w-4" /> Read the docs
                </a>
                <span className="text-[11px] text-faint">Linux · macOS · Windows · Android alpha</span>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-faint">
                <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-ok" /> signed locators</span>
                <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-accent" /> hash-verified files</span>
                <span className="inline-flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-accent-2" /> no vendor account</span>
              </div>
            </div>

            <div className="relative">
              <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-accent/20 via-accent-2/10 to-transparent blur-2xl" />
              <img
                src="/screenshots/welcome.png"
                alt="Nostr Navigator welcome screen"
                className="screenshot relative w-full rounded-2xl border border-line"
                width={1200}
                height={800}
              />
              <div className="glass absolute -bottom-5 -left-4 hidden rounded-xl px-3 py-2 text-[11px] text-muted sm:block">
                <span className="font-mono text-accent">ncc://npub1…/web</span>
                <span className="ml-2 text-faint">resolved in ~1 s</span>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-line/70 bg-panel/40">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-line/60 px-5 sm:grid-cols-4 sm:px-8">
            {[
              ['No registrar', 'the npub is the address'],
              ['No certificate authority', 'signed records, optional pins'],
              ['No platform account', 'keys and data stay yours'],
              ['No reinstall', 'private and Tor tabs included']
            ].map(([title, detail]) => (
              <div key={title} className="bg-ink/90 px-4 py-5">
                <p className="text-[12px] font-semibold text-text">{title}</p>
                <p className="mt-1 text-[11px] text-faint">{detail}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
          <SectionHeading
            eyebrow="What it does"
            title="A browser for the identity-addressed web"
            intro="Everything ordinary browsing needs, plus a native path to services and sites that belong to a key instead of a domain."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <Feature key={feature.title} icon={feature.icon} title={feature.title}>
                {feature.body}
              </Feature>
            ))}
          </div>
        </section>

        <section id="how" className="scroll-mt-20 border-y border-line/70 bg-panel/30">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
            <SectionHeading
              eyebrow="How it works"
              title="Three steps, no gatekeepers"
              intro="The address is a public key. A signed pointer says what is currently served. The browser verifies what it receives."
            />
            <div className="mt-10 grid gap-3 md:grid-cols-3">
              {[
                {
                  step: '01',
                  title: 'Your identity',
                  body: 'An npub is the only address. It is the same on every device and needs no renewal.',
                  code: 'npub1g3…/photos'
                },
                {
                  step: '02',
                  title: 'A signed pointer',
                  body: 'NCC-05 locators and NIP-5A manifests are published to relays. The newest valid record wins.',
                  code: 'kind 30058 · 35128'
                },
                {
                  step: '03',
                  title: 'Verified content',
                  body: 'TLS pins and Blossom hashes are checked before bytes reach the page. A mirror can miss, never lie.',
                  code: 'sha256 · SPKI'
                }
              ].map((item) => (
                <div key={item.step} className="glass rounded-2xl p-5">
                  <span className="font-mono text-[11px] text-accent">{item.step}</span>
                  <h3 className="mt-3 text-[14px] font-semibold text-text">{item.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{item.body}</p>
                  <div className="mt-4 rounded-lg border border-line bg-ink px-2.5 py-2 font-mono text-[11px] text-accent">
                    {item.code}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-2xl border border-accent/20 bg-accent/5 p-5 text-[13px] leading-relaxed text-muted">
              <span className="font-semibold text-text">The npub is the trust anchor.</span>{' '}
              A locator is only honoured if it is signed by the key in the address. Expiry is
              enforced, never extended. A stale record is an error, not a guess.
            </div>
          </div>
        </section>

        <section id="publish" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
          <SectionHeading
            eyebrow="Publish"
            title="Put something on the identity web"
            intro="Two paths, one browser. Static content becomes an nsite; a running app becomes an ncc:// service."
          />
          <div className="mt-10 grid gap-3 lg:grid-cols-2">
            <div className="glass rounded-2xl p-6">
              <div className="flex items-center gap-2 text-accent">
                <FileCode2 className="h-4 w-4" />
                <h3 className="text-[15px] font-semibold text-text">Publish a site</h3>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                Pick a built folder. The browser hashes every file, uploads it to Blossom,
                signs a NIP-5A manifest and publishes it. The result is a static site with no
                host, no DNS, no certificate and no renewal.
              </p>
              <div className="mt-4 rounded-lg border border-line bg-ink px-3 py-2 font-mono text-[11px] text-accent">
                nsite://npub…/navigator/
              </div>
              <ul className="mt-4 space-y-2 text-[12px] text-muted">
                <li className="flex gap-2"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> works for a blog, docs, portfolio or SPA</li>
                <li className="flex gap-2"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> every byte checked against the signed manifest</li>
                <li className="flex gap-2"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> republish only what changed</li>
              </ul>
            </div>
            <div className="glass rounded-2xl p-6">
              <div className="flex items-center gap-2 text-accent-2">
                <Server className="h-4 w-4" />
                <h3 className="text-[15px] font-semibold text-text">Publish a service</h3>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                Point at a service you run — a home lab, a dashboard, a media server. Publish
                a signed locator and share it privately with the people you choose, without a
                domain or an account. Direct internet access needs a port forward; an onion
                address does not.
              </p>
              <div className="mt-4 rounded-lg border border-line bg-ink px-3 py-2 font-mono text-[11px] text-accent-2">
                ncc://npub…/photos
              </div>
              <ul className="mt-4 space-y-2 text-[12px] text-muted">
                <li className="flex gap-2"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> NIP-44 encrypted private links</li>
                <li className="flex gap-2"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> direct, LAN or .onion endpoints</li>
                <li className="flex gap-2"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> revoke, rotate or renew from the browser</li>
              </ul>
            </div>
          </div>
          <p className="mt-5 text-center text-[12px] text-faint">
            <a href={`${DOCS}/site-publishing.md`} className="text-accent hover:underline">Site publishing guide</a>
            <span className="mx-2">·</span>
            <a href={`${DOCS}/hosting.md`} className="text-accent hover:underline">Hosted services guide</a>
          </p>
        </section>

        <section className="border-y border-line/70 bg-panel/30">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
            <SectionHeading
              eyebrow="A closer look"
              title="Browser chrome, trust panel, signer"
              intro="Tabs and an omnibox you already know, with the identity and verification details one click away."
            />
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {[
                ['/screenshots/tabs.png', 'Tabs and the address bar', 'Two resolved services, local suggestions and a padlock that means something.'],
                ['/screenshots/trust.png', 'Site information', 'Service id, anchor, endpoint, TLS pin, expiry and transport — all in one panel.'],
                ['/screenshots/settings.png', 'Settings as a page', 'Identity, relays, Tor, appearance, passwords, extensions and services.']
              ].map(([src, title, caption]) => (
                <figure key={src} className="glass overflow-hidden rounded-2xl">
                  <img src={src} alt={title} className="w-full border-b border-line" loading="lazy" />
                  <figcaption className="p-4">
                    <p className="text-[12px] font-semibold text-text">{title}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">{caption}</p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        <section id="download" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:px-8">
          <SectionHeading
            eyebrow="Download"
            title={`Nostr Navigator v${version}`}
            intro="Pick a platform, or use npack on Linux to install the signed .npk."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <PlatformCard
              icon={<Terminal className="h-4 w-4" />}
              name="Linux"
              detail="Deb, RPM, Flatpak, or the npack .npk."
              files=".deb · .rpm · .flatpak · .npk"
              href={RELEASES}
            />
            <PlatformCard
              icon={<Layers className="h-4 w-4" />}
              name="macOS"
              detail="Apple silicon and Intel. Ad-hoc signed, not notarized."
              files=".dmg · .zip"
              href={RELEASES}
            />
            <PlatformCard
              icon={<MonitorSmartphone className="h-4 w-4" />}
              name="Windows"
              detail="x64 installer. Unsigned, so SmartScreen may ask."
              files="setup.exe"
              href={RELEASES}
            />
            <PlatformCard
              icon={<Zap className="h-4 w-4" />}
              name="Android"
              detail="Alpha arm64 APK. Zapstore or direct."
              files=".apk"
              href={RELEASES}
            />
          </div>
          <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[12px] font-semibold text-text">
                <Terminal className="h-3.5 w-3.5 text-accent" /> Install with npack
              </p>
              <code className="mt-1 block truncate font-mono text-[11px] text-accent">{NPACK_COMMAND}</code>
            </div>
            <div className="flex items-center gap-2">
              <CopyButton value={NPACK_COMMAND} label="Copy command" />
              <a
                href={npkUrl}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-muted hover:text-text"
              >
                <Download className="h-3 w-3" /> .npk
              </a>
            </div>
          </div>
          <p className="mt-4 text-center text-[11px] text-faint">
            Latest release metadata is read from Nostr relays. Prefer the{' '}
            <a href={RELEASES} className="text-accent hover:underline">GitHub release page</a>{' '}
            for checksums and all assets.
          </p>
        </section>

        <section className="border-t border-line/70">
          <div className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
            <SectionHeading eyebrow="FAQ" title="Questions worth asking" />
            <div className="mt-8 space-y-2">
              {[
                {
                  q: 'Is it a normal browser too?',
                  a: 'Yes. Clearnet https:// pages, tabs, history, bookmarks, downloads, extensions and a password manager work as usual. ncc:// and nsite:// are additional address families, not a replacement for the web.'
                },
                {
                  q: 'Do I need a Nostr key?',
                  a: 'You can browse public ncc:// services and nsite:// sites without one. A key is needed to sign in to services, unlock the password vault, sync, or publish. You can generate one in Settings or connect a NIP-46 remote signer.'
                },
                {
                  q: 'What is NCC-05?',
                  a: 'A signed locator convention: a kind 30058 event published to Nostr relays that says which endpoints currently serve a named service for an npub. The browser resolves it, enforces expiry, and optionally pins the endpoint TLS key.'
                },
                {
                  q: 'Do I need NCC-02?',
                  a: 'No. NCC-02 is the identity and trust anchor, but it is optional: NCC-05 locators work unanchored. You can require it in Settings → General. In strict mode, publishing a service or private share also publishes an NCC-02 anchor — without the endpoint for a private service — and fails if no relay accepts the anchor.'
                },
                {
                  q: 'Can I share with more than one person?',
                  a: 'Yes. Services → Share lists your Nostr follow list, cached for quick reuse and refreshable. Select any number of contacts; each gets their own encrypted link and no-endpoint NCC-02 anchor, because NIP-44 has one conversation key per recipient. Each link can be revoked or renewed independently.'
                },
                {
                  q: 'How does a local service become reachable?',
                  a: 'Publish this page scans the page address, this machine’s interfaces and the local router. It offers loopback (owner only), LAN, global IPv6, the current HTTPS URL and any onion address as endpoint candidates, each with a confidence label. The router WAN address is read over UPnP or NAT-PMP; a 100.64/10 address means carrier-grade NAT, where direct IPv4 needs a tunnel and Tor is the realistic path. A public address is still unverified until a port is mapped and checked. Confirming the real internet egress with an external service is off by default and only runs when you ask.'
                },
                {
                  q: 'How do I make a local service reachable behind CGNAT?',
                  a: 'Use the Onion action on the service card. The bundled Tor creates a hidden service for the loopback endpoint, verifies it through the browser’s own SOCKS proxy, and adds the onion address to the locator. The key is stored locally and reused, so the address stays stable, and nothing is opened on your router. The onion only runs while Tor and the browser run. Direct IPv4 needs a port forward, which CGNAT does not allow.'
                },
                {
                  q: 'Does it forward a port automatically?',
                  a: 'No. If the router answers UPnP and you opened a local page, the publish form offers an explicit “Map a TCP port” action. It forwards one TCP port to this machine, is described as Nostr Navigator, expires after two hours and is removed when the browser quits. The mapped URL is added as unverified. A CGNAT or private WAN address is refused, because forwarding cannot fix it — use the Tor onion endpoint instead.'
                },
                {
                  q: 'Does it contact an external service?',
                  a: 'Only if you allow it. Settings → General has Ask, Always or Never for public address confirmation. The provider (api64.ipify.org) is named in the form, sees your IP but not your identity or services, and the result is cached for ten minutes. It never runs while Tor is preferred. Without it, the router WAN address and a Tor onion endpoint are enough for most cases.'
                },
                {
                  q: 'What happens when my IP address changes?',
                  a: 'Services watches this machine’s interfaces once a minute and the router WAN address every ten minutes. When an IPv4 address, IPv6 prefix or WAN changes, a banner shows the old and new value. “Update & republish” rewrites matching endpoints and signs new locators; “Update endpoints only” leaves publishing to you. A remote signer may ask for approval. Loopback and link-local addresses are ignored.'
                },
                {
                  q: 'How do I know a forwarded port really works?',
                  a: 'On a mapped port, “Check reachability” opens a TCP connection to the public address through a Tor exit node — an outside vantage point that needs no extra service. Success marks it reachable from the internet. While Tor runs, mappings are re-checked every ten minutes; two failures raise a Services alert with “Check again”. The mapping uses UPnP first and falls back to NAT-PMP, has a two-hour lease, and is removed when the browser quits.'
                },
                {
                  q: 'Can a service use its own Nostr identity?',
                  a: 'Yes. The Add service form lists your identities and lets you create another. One checkbox decides whether it is added to your identity list or used once for this session. A one-off key is shown as an nsec so you can save it; without it the service cannot be renewed or shared later. Publishing never creates an identity silently.'
                },
                {
                  q: 'How do I use a self-signed certificate?',
                  a: 'HTTPS endpoints support a `k` pin. Import an existing certificate to derive the pin, or generate a self-signed certificate and key for the endpoint hosts; the key is saved with 0600 permissions. Install the generated files in your own server, then the browser pins that exact key. The browser does not terminate TLS for the service.'
                },
                {
                  q: 'Where is the source?',
                  a: `The canonical repository is on GitHub. It is also mirrored as a Nostr git repository: the NIP-34 announcement is on relay.ngit.dev and the browser is at gitworkshop.dev. NostrHub is a second web index for the same repository.`
                },
                {
                  q: 'What is an nsite?',
                  a: 'A NIP-5A static site: a signed manifest listing paths and sha256 hashes, with the files stored on Blossom. The browser fetches and verifies every file; there is no web server to trust.'
                },
                {
                  q: 'Are the builds signed?',
                  a: 'Linux packages are built by the release workflow. macOS builds are ad-hoc signed but not notarized, and the Windows installer has no Authenticode signature yet, so both can show the usual prompts.'
                },
                {
                  q: 'Does it work on Android?',
                  a: 'There is an alpha arm64 build: locators, a loopback proxy with key pinning, the built-in signer and a wallet. Tabs and extensions are limited. Desktop is the primary target.'
                }
              ].map((item) => (
                <details key={item.q} className="group rounded-xl border border-line bg-panel px-4 py-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-text">
                    {item.q}
                    <ChevronDown className="h-4 w-4 shrink-0 text-faint transition group-open:rotate-180" />
                  </summary>
                  <p className="mt-2 text-[12px] leading-relaxed text-muted">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-panel/40">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <div className="flex items-center gap-2.5">
                <img src="/icon.svg" alt="" className="h-8 w-8" />
                <span className="text-[13px] font-semibold text-text">Nostr Navigator</span>
              </div>
              <p className="mt-2 max-w-sm text-[11px] leading-relaxed text-faint">
                No DNS. Just keys. A browser for services and sites addressed by Nostr identity.
                MIT licensed.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-10 gap-y-2 text-[11px] text-muted sm:grid-cols-3">
              <a href={REPO} className="hover:text-text">GitHub</a>
              <a href={GIT_MIRROR} className="hover:text-text">Nostr git mirror</a>
              <a href={NOSTRHUB} className="hover:text-text">NostrHub</a>
              <a href={RELEASES} className="hover:text-text">Releases</a>
              <a href={DOCS} className="hover:text-text">Docs</a>
              <a href={SPEC} className="hover:text-text">NCC conventions</a>
              <a href={NPACK} className="hover:text-text">npack</a>
              <a href={`${REPO}/blob/main/README.md`} className="hover:text-text">README</a>
              <a href={WHITE_NOISE_CONTACT} className="inline-flex items-center gap-1.5 hover:text-text">
                <img src="/whitenoise-logo.svg" alt="" className="h-3.5 w-3.5 rounded-sm" /> Message us on White Noise
              </a>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[10px] text-faint">
            <span>This page is published with Nostr Navigator as an nsite.</span>
            <span className="inline-flex items-center gap-1.5 font-mono">
              <Globe className="h-3 w-3" /> nsite://{SITE_NPUB.slice(0, 12)}…/
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}
