import type { CertificateInfo } from '@shared/hosting'

export interface CertificateFieldsProps {
  pins: Record<string, string>
  info: CertificateInfo | null
  paths: { certPath: string; keyPath: string } | null
  busy: boolean
  onImport: () => void
  onGenerate: () => void
  onClear: () => void
}

/** Import or generate a TLS certificate and pin it to the draft's HTTPS endpoints. */
export function CertificateFields({
  pins,
  info,
  paths,
  busy,
  onImport,
  onGenerate,
  onClear
}: CertificateFieldsProps) {
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-ui-105 font-semibold text-[color:var(--color-text-strong)]">
            TLS certificate
          </p>
          <p className="text-ui-95 leading-relaxed text-[color:var(--color-muted)]">
            Pin the server&apos;s TLS key so recipients accept a self-signed certificate. Import
            an existing certificate, or generate a self-signed one and install it in your own
            server; the browser never terminates TLS for the service.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            data-import-certificate
            disabled={busy}
            onClick={onImport}
            className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-105 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            Import certificate
          </button>
          <button
            type="button"
            data-generate-certificate
            disabled={busy}
            onClick={onGenerate}
            className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-105 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Generate self-signed'}
          </button>
        </div>
      </div>
      {Object.values(pins).length > 0 ? (
        <div className="mt-2 rounded-lg border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/10 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui-95 text-[color:var(--color-ok)]">TLS pin set</span>
            <span className="min-w-0 break-all font-mono text-ui-95 text-[color:var(--color-muted)]">
              {Object.values(pins)[0]}
            </span>
            <button
              type="button"
              onClick={onClear}
              className="ml-auto rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
            >
              Remove pin
            </button>
          </div>
          {info ? (
            <p className="mt-0.5 break-all text-ui-95 text-[color:var(--color-faint)]">
              {info.subject} · valid to {info.validTo}
              {info.names.length ? ` · ${info.names.join(', ')}` : ''}
            </p>
          ) : null}
          {paths ? (
            <p className="mt-0.5 break-all font-mono text-ui-95 text-[color:var(--color-faint)]">
              Saved {paths.certPath} and {paths.keyPath} (key 0600)
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-ui-95 text-[color:var(--color-faint)]">
          No pin. HTTPS endpoints use normal CA validation; plain HTTP endpoints need no
          certificate.
        </p>
      )}
    </div>
  )
}
