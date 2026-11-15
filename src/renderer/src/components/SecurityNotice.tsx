import { AlertTriangle, ChevronLeft, ShieldAlert } from 'lucide-react'
import type { InsecurePrompt, SecurityBanner } from '@shared/types'

export function SecurityBanner({ banner }: { banner: SecurityBanner }) {
  return (
    <div
      data-insecure-banner
      className="flex h-[30px] shrink-0 items-center gap-2 border-b border-[color:var(--color-warn)]/20 bg-[color:var(--color-warn)]/[0.08] px-3 text-[11px] text-[color:var(--color-warn)]"
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
        <span className="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2.5 py-1 text-[10.5px] font-medium text-[color:var(--color-warn)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          {httpsOnly ? 'HTTPS required' : 'HTTP'}
        </span>
        <h2 className="mt-4 text-[19px] font-semibold text-[#e7e9ef]">{title}</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--color-muted)]">
          {detail}
        </p>
        <div className="mt-4 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2.5">
          <p className="truncate font-mono text-[11px] text-[#c9d1e0]">{prompt.url}</p>
          <p className="mt-1 text-[10.5px] text-[color:var(--color-muted)]">{prompt.host}</p>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            data-insecure-go-back
            onClick={() => onChoice('cancel')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-[11.5px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Go back
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-insecure-always
              onClick={() => onChoice('always')}
              className="rounded-lg border border-[color:var(--color-warn)]/30 px-3 py-1.5 text-[11.5px] text-[color:var(--color-warn)] hover:bg-[color:var(--color-warn)]/10"
            >
              {prompt.ephemeral ? 'Always for this session' : 'Always allow this site'}
            </button>
            <button
              type="button"
              data-insecure-continue
              onClick={() => onChoice('continue')}
              className="rounded-lg bg-[color:var(--color-warn)] px-3.5 py-1.5 text-[11.5px] font-semibold text-[#0b0c10]"
            >
              Continue once
            </button>
          </div>
        </div>
        <p className="mt-3 text-[10.5px] leading-relaxed text-[#5d6575]">
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
