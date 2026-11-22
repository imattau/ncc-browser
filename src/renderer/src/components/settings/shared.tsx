import { Copy, ShieldCheck } from 'lucide-react'
import { formatBytes } from '@shared/site-data'
import type { TorStatus } from '@shared/types'

/** Section title and one-line explanation, used at the top of every settings section. */
export function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">{title}</h2>
      <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
        {hint}
      </p>
    </div>
  )
}

/** One labelled cache-size row in the security section. */
export function CacheRow({
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

/** One label/value row in the About section. */
export function AboutRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-lg bg-[color:var(--color-field)] px-2.5 py-1.5">
      <dt className="text-[color:var(--color-muted)]">{label}</dt>
      <dd className="font-mono text-ui-105 text-[color:var(--color-text-soft)]">{value ?? '—'}</dd>
    </div>
  )
}

/** The npub of the active identity, with a copy affordance. */
export function IdentityKey({
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

/** One line describing the Tor runtime for the general section. */
export function torStatusText(status: TorStatus | null): string {
  if (!status) return 'Tor has not been started.'
  if (status.starting) return 'Starting Tor…'
  if (status.ready && status.proxy) {
    return `${status.kind === 'bundled' ? 'Bundled Tor' : 'Local Tor'} ready on ${status.proxy}`
  }
  if (status.error) return 'Tor is unavailable.'
  return 'Tor starts automatically when an onion service is opened.'
}

/** Human name for `process.platform`. */
export function platformName(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}
