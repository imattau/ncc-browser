import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import {
  nsiteSiteAddress,
  validateNsiteSiteId,
  type NsiteFolderScan,
  type NsiteProgress,
  type NsitePublishResult,
  type NsitePublishState,
  type NsiteVerifyResult,
  type PublishedNsite
} from '@shared/nsite-publish'
import type { IdentityStatus } from '@shared/types'
import { cn } from '../lib/cn'
import { messageOf, relativeSeconds, shortIdentity } from '../lib/format'

interface SitePublishingSettingsProps {
  identity: IdentityStatus | null
  onOpenIdentity: () => void
  onClose: () => void
}

const DEFAULT_SERVERS = [
  'https://blossom.ditto.pub',
  'https://nostr.download',
  'https://blossom.primal.net'
]

interface Draft {
  root: boolean
  siteId: string
  title: string
  description: string
  source: string
  serverText: string
  relayText: string
}

const EMPTY_DRAFT: Draft = {
  root: false,
  siteId: '',
  title: '',
  description: '',
  source: '',
  serverText: DEFAULT_SERVERS.join('\n'),
  relayText: ''
}

function lines(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SitePublishingSettings({
  identity,
  onOpenIdentity,
  onClose
}: SitePublishingSettingsProps) {
  const [state, setState] = useState<NsitePublishState | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [scan, setScan] = useState<NsiteFolderScan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<NsiteProgress | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<NsitePublishResult | null>(null)
  const [verification, setVerification] = useState<NsiteVerifyResult | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryNote, setDiscoveryNote] = useState<string | null>(null)

  const apply = useCallback((next: NsitePublishState) => setState(next), [])

  const discoverSites = useCallback(async (): Promise<void> => {
    setDiscovering(true)
    setDiscoveryNote(null)
    try {
      const result = await window.ncc.nsiteDiscover()
      apply(result.state)
      setDiscoveryNote(
        result.error ??
          `Found ${result.found} published site${result.found === 1 ? '' : 's'} on ${result.relays} relay${result.relays === 1 ? '' : 's'}.`
      )
    } catch (discoveryError) {
      setDiscoveryNote(messageOf(discoveryError))
    } finally {
      setDiscovering(false)
    }
  }, [apply])

  useEffect(() => {
    let alive = true
    void window.ncc.nsiteState().then((next) => alive && apply(next))
    void window.ncc.getConfig().then((config) => {
      if (!alive) return
      setDraft((current) =>
        current.relayText
          ? current
          : { ...current, relayText: config.relays.map((entry) => entry.url).join('\n') }
      )
    })
    void discoverSites()
    const offState = window.ncc.onNsiteChanged((next) => alive && apply(next))
    const offProgress = window.ncc.onNsiteProgress((next) => {
      if (!alive) return
      setProgress(next)
      if (next.log) setLog((entries) => [...entries.slice(-100), next.log as string])
    })
    return () => {
      alive = false
      offState()
      offProgress()
    }
  }, [apply, discoverSites])

  const sites = state?.sites ?? []
  const siteIdError = useMemo(() => {
    if (draft.root) return null
    return draft.siteId.trim()
      ? validateNsiteSiteId(draft.siteId)
      : 'Enter a site id, or tick the root site box.'
  }, [draft.root, draft.siteId])
  const fileProblems = scan?.problems ?? []

  const pick = useCallback(async (site?: PublishedNsite): Promise<void> => {
    setBusy(true)
    setError(null)
    setResult(null)
    setVerification(null)
    setLog([])
    setProgress(null)
    try {
      const next = await window.ncc.nsitePickFolder()
      if (!next) return
      setScan(next)
      if (site) {
        setDraft({
          root: site.siteId === null,
          siteId: site.siteId ?? '',
          title: site.title ?? '',
          description: site.description ?? '',
          source: site.source ?? '',
          serverText: site.servers.join('\n') || DEFAULT_SERVERS.join('\n'),
          relayText: draft.relayText
        })
      } else {
        const suggested = next.folderName
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 13)
        setDraft((current) => ({
          ...current,
          siteId: current.siteId || suggested,
          title: current.title || (suggested ? suggested : 'My site')
        }))
      }
    } catch (pickError) {
      setError(messageOf(pickError))
    } finally {
      setBusy(false)
    }
  }, [draft.relayText])

  const publish = async (): Promise<void> => {
    if (!scan) return setError('Choose a built site folder first')
    if (siteIdError) return setError(siteIdError)
    if (fileProblems.length > 0) return setError(fileProblems.join(' '))
    const servers = lines(draft.serverText)
    const relays = lines(draft.relayText)
    if (servers.length === 0) return setError('Add at least one Blossom server')
    setBusy(true)
    setError(null)
    setResult(null)
    setVerification(null)
    setLog([])
    try {
      const next = await window.ncc.nsitePublish({
        token: scan.token,
        siteId: draft.root ? null : draft.siteId,
        title: draft.title,
        description: draft.description,
        source: draft.source,
        servers,
        relays
      })
      if ('cancelled' in next) {
        setLog((entries) => [...entries, 'Publish cancelled'])
        setResult(null)
        apply(await window.ncc.nsiteState())
        return
      }
      setResult(next)
      apply(await window.ncc.nsiteState())
      setScan(null)
    } catch (publishError) {
      setError(messageOf(publishError))
      apply(await window.ncc.nsiteState())
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const verify = async (site: PublishedNsite): Promise<void> => {
    setBusy(true)
    setError(null)
    setVerification(null)
    setLog([])
    try {
      const next = await window.ncc.nsiteVerify(site.id)
      if ('cancelled' in next) {
        setLog((entries) => [...entries, 'Verification cancelled'])
        setVerification(null)
        return
      }
      setVerification(next)
    } catch (verifyError) {
      setError(messageOf(verifyError))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const cancel = async (): Promise<void> => {
    const accepted = await window.ncc.nsiteCancel()
    if (accepted) setLog((entries) => [...entries, 'Cancelling…'])
  }

  const remove = async (site: PublishedNsite): Promise<void> => {
    if (
      !window.confirm(
        'Remove this site and publish a deletion request (NIP-09) to Nostr?\n\n' +
          'Relays may delete the manifest. Republishing the same address from its folder restores it.'
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const removed = await window.ncc.nsiteRemove(site.id)
      apply(removed.state)
      if (removed.error) setError(removed.error)
      else {
        const accepted = removed.reports.filter((report) => report.ok).length
        setDiscoveryNote(
          `Deletion request accepted by ${accepted} of ${removed.reports.length} relay${removed.reports.length === 1 ? '' : 's'}.`
        )
      }
      if (result?.site.id === site.id) setResult(null)
      if (verification?.id === site.id) setVerification(null)
    } catch (removeError) {
      setError(messageOf(removeError))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (id: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      setError('Could not copy to the clipboard')
    }
  }

  if (!state) return null

  return (
    <div className="space-y-5" data-nsite-settings>
      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">Sites</h2>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Publish a static folder as a NIP-5A site. Files go to Blossom, a signed manifest
          goes to relays, and the address is{' '}
          <span className="font-mono text-[color:var(--color-text)]">nsite://&lt;your npub&gt;/&lt;site&gt;</span>.
          No host, domain, certificate or renewal.
        </p>
      </div>

      {!identity?.configured ? (
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-12 text-[color:var(--color-muted)]">
          Publishing needs an identity to sign the manifest.{' '}
          <button
            type="button"
            onClick={onOpenIdentity}
            className="text-[color:var(--color-accent)] underline-offset-2 hover:underline"
          >
            Set up an identity
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {busy && !scan ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-11 text-[color:var(--color-muted)]">
          <span>Working…</span>
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-10 hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
          >
            Cancel
          </button>
        </div>
      ) : null}

      <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Publish a site</h3>
            <p className="text-ui-105 text-[color:var(--color-muted)]">
              {scan
                ? `${scan.folderName} · ${scan.files.length} files · ${formatBytes(scan.totalBytes)}`
                : 'Choose the built folder, with index.html at its root.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void pick()}
            data-nsite-pick
            disabled={busy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {scan ? 'Choose another folder' : 'Choose folder'}
          </button>
        </div>

        {scan ? (
          <>
            {fileProblems.length > 0 ? (
              <ul className="space-y-0.5 rounded-lg bg-[color:var(--color-danger)]/10 px-2.5 py-2 text-ui-10 text-[color:var(--color-danger)]">
                {fileProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}

            <label className="flex items-center gap-2 text-ui-11 text-[color:var(--color-muted)]">
              <input
                type="checkbox"
                checked={draft.root}
                onChange={(event) => setDraft({ ...draft, root: event.target.checked })}
                className="h-4 w-4 accent-[color:var(--color-accent)]"
              />
              Publish as this identity&apos;s root site (<span className="font-mono">nsite://&lt;npub&gt;/</span>)
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Site id
                <input
                  value={draft.siteId}
                  data-nsite-site-id
                  disabled={draft.root}
                  maxLength={13}
                  onChange={(event) => setDraft({ ...draft, siteId: event.target.value })}
                  placeholder="my-site"
                  className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)] disabled:opacity-50"
                />
                {siteIdError ? (
                  <span className="text-ui-10 text-[color:var(--color-danger)]">{siteIdError}</span>
                ) : null}
              </label>
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Title
                <input
                  value={draft.title}
                  data-nsite-title
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
                />
              </label>
            </div>

            <label className="block text-ui-105 text-[color:var(--color-muted)]">
              Description
              <input
                value={draft.description}
                data-nsite-description
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
              />
            </label>

            <label className="block text-ui-105 text-[color:var(--color-muted)]">
              Source (optional)
              <input
                value={draft.source}
                data-nsite-source
                onChange={(event) => setDraft({ ...draft, source: event.target.value })}
                placeholder="https://github.com/you/site"
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Blossom servers
                <textarea
                  rows={3}
                  data-nsite-servers
                  value={draft.serverText}
                  onChange={(event) => setDraft({ ...draft, serverText: event.target.value })}
                  spellCheck={false}
                  className="mt-1 w-full resize-y rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-10 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
                />
              </label>
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Relays
                <textarea
                  rows={3}
                  data-nsite-relays
                  value={draft.relayText}
                  onChange={(event) => setDraft({ ...draft, relayText: event.target.value })}
                  spellCheck={false}
                  className="mt-1 w-full resize-y rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-10 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void publish()}
                data-nsite-publish
                disabled={busy || !identity?.configured || fileProblems.length > 0 || Boolean(siteIdError)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {busy ? 'Publishing…' : 'Upload and publish'}
              </button>
              {busy ? (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                >
                  Cancel
                </button>
              ) : null}
              <span className="text-ui-10 text-[color:var(--color-faint)]">
                {scan.files.length} files · {formatBytes(scan.totalBytes)}
              </span>
            </div>

            {progress ? (
              <div className="rounded-lg bg-[color:var(--color-field)] px-2.5 py-2 text-ui-10 text-[color:var(--color-muted)]">
                <div className="flex justify-between gap-2">
                  <span>{progress.label}</span>
                  <span>
                    {progress.done}/{progress.total}
                  </span>
                </div>
                <progress
                  className="mt-1 h-1.5 w-full"
                  value={progress.done}
                  max={Math.max(1, progress.total)}
                />
              </div>
            ) : null}

            <div className="max-h-40 overflow-y-auto rounded-lg bg-[color:var(--color-ink)]/60 p-2 font-mono text-ui-95 text-[color:var(--color-muted)]">
              {scan.files.slice(0, 40).map((file) => (
                <div key={file.path} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="shrink-0 text-[color:var(--color-faint)]">{formatBytes(file.size)}</span>
                </div>
              ))}
              {scan.files.length > 40 ? (
                <div className="text-[color:var(--color-faint)]">+{scan.files.length - 40} more…</div>
              ) : null}
            </div>
          </>
        ) : null}

        {log.length > 0 ? (
          <div className="max-h-32 overflow-y-auto rounded-lg bg-[color:var(--color-ink)]/60 p-2 font-mono text-ui-95 text-[color:var(--color-muted)]">
            {log.map((entry, index) => (
              <div key={`${index}-${entry}`} className="truncate">
                {entry}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {result ? (
        <div data-nsite-result className="space-y-2 rounded-xl border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/5 p-4">
          <h3 className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
            <Check className="h-4 w-4 text-[color:var(--color-ok)]" />
            Published
          </h3>
          <button
            type="button"
            onClick={() => void copy('result', result.address)}
            className="flex w-full items-center gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-2 text-left font-mono text-ui-11 text-[color:var(--color-text)]"
          >
            <Globe className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-accent)]" />
            <span className="truncate">{result.address}</span>
            <span className="ml-auto text-[color:var(--color-muted)]">
              {copied === 'result' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </span>
          </button>
          <div className="flex flex-wrap gap-2 text-ui-10 text-[color:var(--color-muted)]">
            <span>{result.site.files.length} files</span>
            <span>·</span>
            <span>{result.site.servers.length} server(s)</span>
            <span>·</span>
            <span>{result.reports.filter((report) => report.ok).length}/{result.reports.length} relays</span>
          </div>
          {result.reports.some((report) => !report.ok) ? (
            <p className="text-ui-10 text-[color:var(--color-danger)]">
              {result.reports
                .filter((report) => !report.ok)
                .map((report) => `${report.relay}: ${report.message}`)
                .join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {verification ? (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-ui-11',
            verification.missing.length === 0
              ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
              : 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
          )}
        >
          {verification.missing.length === 0
            ? `All ${verification.checked} files match their manifest hashes on at least one server.`
            : `${verification.missing.length} of ${verification.checked} files were not found or did not match: ${verification.missing.join(', ')}`}
        </p>
      ) : null}

      <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Published sites</h3>
            <p className="text-ui-105 text-[color:var(--color-muted)]">
              Republishing with the same site id replaces the manifest. Unchanged files are skipped by hash.
            </p>
            {discoveryNote ? (
              <p data-nsite-discovery className="mt-1 text-ui-10 text-[color:var(--color-faint)]">
                {discoveryNote}
              </p>
            ) : null}
            {(state?.hidden?.length ?? 0) > 0 ? (
              <p className="mt-0.5 text-ui-10 text-[color:var(--color-faint)]">
                {state?.hidden?.length} removed site{state?.hidden?.length === 1 ? '' : 's'} hidden from
                relay discovery; republishing the same address restores it.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            data-nsite-discover
            onClick={() => void discoverSites()}
            disabled={discovering || busy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', discovering && 'animate-spin')} />
            {discovering ? 'Looking for sites…' : 'Find published'}
          </button>
        </div>

        {sites.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[color:var(--color-line)] px-4 py-6 text-center text-ui-11 text-[color:var(--color-faint)]">
            {discovering
              ? 'Looking for manifests on your relays…'
              : 'Nothing published from this browser yet. Published sites are discovered from your relays.'}
          </p>
        ) : (
          sites.map((site) => {
            const address = nsiteSiteAddress(site.owner, site.siteId)
            return (
              <div
                key={site.id}
                data-nsite-site={site.siteId ?? 'root'}
                className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                        {site.title || site.siteId || 'Root site'}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-ui-95',
                          site.lastPublishError
                            ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
                            : 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                        )}
                      >
                        {site.lastPublishError ? 'failed' : `published ${relativeSeconds(site.lastPublishedAt)}`}
                      </span>
                      <span className="text-ui-95 text-[color:var(--color-faint)]">
                        {site.files.length} files · {site.servers.length} server(s)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copy(`site:${site.id}`, address)}
                      className="mt-1 block max-w-full truncate font-mono text-ui-105 text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
                    >
                      {copied === `site:${site.id}` ? 'copied' : address}
                    </button>
                    <div className="mt-0.5 truncate text-ui-95 text-[color:var(--color-faint)]">
                      owner {shortIdentity(site.owner)} · {site.servers.join(' · ')}
                    </div>
                    {site.lastPublishError ? (
                      <p className="mt-1 text-ui-10 text-[color:var(--color-danger)]">{site.lastPublishError}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        void window.ncc.navigate(address)
                        onClose()
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                    >
                      <ExternalLink className="h-3 w-3" /> Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void pick(site)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
                    >
                      <RefreshCw className="h-3 w-3" /> Republish
                    </button>
                    <button
                      type="button"
                      onClick={() => void verify(site)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
                    >
                      <FileText className="h-3 w-3" /> Verify
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(site)}
                      disabled={busy}
                      title="Remove from this browser"
                      aria-label={`Remove ${site.title || site.siteId || 'root site'}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)] disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      <p className="flex items-start gap-2 text-ui-10 leading-relaxed text-[color:var(--color-faint)]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Sites are public: NIP-5A has no access control. Blossom servers may garbage-collect
        unpinned blobs, so publish to more than one and keep the source folder. The browser
        does not keep the site files, only the manifest index.
      </p>

      <button
        type="button"
        onClick={() => {
          void window.ncc.newTab('nccpublish://app/')
          onClose()
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
      >
        <ExternalLink className="h-3 w-3" />
        Open the standalone publisher page
      </button>
    </div>
  )
}
