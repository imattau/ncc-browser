import { AlertTriangle, ChevronLeft, ShieldAlert } from 'lucide-react'
import type { InsecurePrompt, SecurityBanner } from '@shared/types'

export function SecurityBanner({ banner }: { banner: SecurityBanner }) {
  return (
    <div
      data-insecure-banner
      className="flex h-[30px] shrink-0 items-center gap-2 border-b border-[color:var(--color-warn)]/20 bg-[color:var(--color-warn)]/[0.08] px-3 text-ui-11 text-[color:var(--color-warn)]"
    >
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span className="font-medium">{banner.title}</span>
      <span className="truncate text-[color:var(--color-warn)]/80">{banner.detail}</span>
    </div>
  )
}

interface InsecureWarningProps {
  prompt: InsecurePrompt
  onChoice: (choice: 'cancel' | 'continue' | 'always') => void
}

export function InsecureWarning({ prompt, onChoice }: InsecureWarningProps) {
  const httpsOnly = prompt.mode === 'only'
  const title = httpsOnly ? 'HTTPS is unavailable' : 'This connection is not secure'
  const detail = prompt.tor
    ? 'Tor encrypts the path to this service, but the page itself has no TLS layer.'
    : httpsOnly
      ? 'HTTPS-only is enabled, and this destination would be loaded over plaintext HTTP.'
      : 'This destination would be loaded over plaintext HTTP. Anyone on the network can read or modify it.'

  return (
    <section
      data-insecure-prompt
      aria-label="Insecure connection warning"
      className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-[color:var(--color-ink)] px-6 py-10"
    >
      <div className="w-full max-w-[560px] rounded-2xl border border-[color:var(--color-warn)]/30 bg-[color:var(--color-panel-raised)] p-6 shadow-[0_30px_100px_rgba(0,0,0,0.5)]">
        <span className="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2.5 py-1 text-ui-105 font-medium text-[color:var(--color-warn)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          {httpsOnly ? 'HTTPS required' : 'HTTP'}
        </span>
        <h2 className="mt-4 text-ui-19 font-semibold text-[color:var(--color-text-strong)]">{title}</h2>
        <p className="mt-2 text-ui-125 leading-relaxed text-[color:var(--color-muted)]">
          {detail}
        </p>
        <div className="mt-4 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
          <p className="truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">{prompt.url}</p>
          <p className="mt-1 text-ui-105 text-[color:var(--color-muted)]">{prompt.host}</p>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            data-insecure-go-back
            onClick={() => onChoice('cancel')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Go back
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-insecure-always
              onClick={() => onChoice('always')}
              className="rounded-lg border border-[color:var(--color-warn)]/30 px-3 py-1.5 text-ui-115 text-[color:var(--color-warn)] hover:bg-[color:var(--color-warn)]/10"
            >
              {prompt.ephemeral ? 'Always for this session' : 'Always allow this site'}
            </button>
            <button
              type="button"
              data-insecure-continue
              onClick={() => onChoice('continue')}
              className="rounded-lg bg-[color:var(--color-warn)] px-3.5 py-1.5 text-ui-115 font-semibold text-[color:var(--color-on-warn)]"
            >
              Continue once
            </button>
          </div>
        </div>
        <p className="mt-3 text-ui-105 leading-relaxed text-[color:var(--color-faint)]">
          {prompt.mode === 'prefer'
            ? 'Prefer HTTPS is on. This prompt appears because the HTTPS attempt failed or the destination is HTTP.'
            : prompt.mode === 'off'
              ? 'HTTPS upgrades are off. You can turn them on in Settings → Security.'
              : 'HTTPS-only never loads HTTP silently; this is your explicit exception.'}
        </p>
      </div>
    </section>
  )
}
