import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ExternalLink, FileText, RefreshCw, Trash2 } from 'lucide-react'
import {
  nsiteSiteAddress,
  type NsitePublishState,
  type PublishedNsite
} from '@shared/nsite-publish'
import type { IdentityStatus } from '@shared/types'
import { cn } from '../lib/cn'
import { messageOf, relativeSeconds, shortIdentity } from '../lib/format'
import { useHostingIdentity } from './hosting/useHostingIdentity'
import { SiteWizard } from './sites/SiteWizard'
import { VerifyStatus } from './sites/VerifyStatus'
import {
  listenForSiteProgress,
  patchSiteDraft,
  pickSiteFolder,
  resetSiteFlow,
  restoreSiteFlow,
  siteFlow,
  verifySite,
  worthKeeping
} from './sites/siteFlow'

interface SitePublishingSettingsProps {
  identity: IdentityStatus | null
  onOpenIdentity: () => void
  onIdentityChange?: (status: IdentityStatus) => void
  onClose: () => void
}

export function SitePublishingSettings({
  identity,
  onOpenIdentity,
  onIdentityChange,
  onClose
}: SitePublishingSettingsProps) {
  const [state, setState] = useState<NsitePublishState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const identityAdmin = useHostingIdentity({ identity, onIdentityChange, setError })
  const [copied, setCopied] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryNote, setDiscoveryNote] = useState<string | null>(null)
  const flow = siteFlow.use()

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
    listenForSiteProgress()
    void restoreSiteFlow()
    let alive = true
    void window.ncc.nsiteState().then((next) => alive && apply(next))
    void window.ncc.getConfig().then((config) => {
      if (!alive) return
      if (!siteFlow.get().draft.relayText) {
        patchSiteDraft({ relayText: config.relays.map((entry) => entry.url).join('\n') })
      }
    })
    void discoverSites()
    const offState = window.ncc.onNsiteChanged((next) => alive && apply(next))
    return () => {
      alive = false
      offState()
    }
  }, [apply, discoverSites])

  const sites = state?.sites ?? []
  const working = busy || flow.job?.status === 'running' || Boolean(flow.verify?.running)
  /** While a new site is being set up, the list below would only be in the way. */
  const settingUp = !flow.job ? Boolean(flow.scan) : flow.job.status !== 'done'
  const resultId = flow.job?.result?.site.id

  const republish = async (site: PublishedNsite): Promise<void> => {
    const current = siteFlow.get()
    if (
      current.recovered &&
      worthKeeping(current) &&
      !window.confirm('You have an unfinished site setup. Discard it and update this site instead?')
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await pickSiteFolder(site)
    } catch (pickError) {
      setError(messageOf(pickError))
    } finally {
      setBusy(false)
    }
  }

  const openAddress = (address: string): void => {
    void window.ncc.navigate(address)
    onClose()
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
      const current = siteFlow.get()
      if (current.job?.result?.site.id === site.id) resetSiteFlow()
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
          Put a website online straight from a folder on this computer. You don&apos;t need a web
          host or a domain, and there is nothing to renew. Published sites are public.
        </p>
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <SiteWizard
        identity={identity}
        identityAdmin={identityAdmin}
        sites={sites}
        copied={copied}
        copy={copy}
        onError={setError}
        onOpen={openAddress}
        onOpenIdentity={onOpenIdentity}
      />

      {settingUp ? null : (
        <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Published sites</h3>
              <p className="text-ui-105 text-[color:var(--color-muted)]">
                To change a site, choose Update and pick its folder again.
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
              disabled={discovering || working}
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
                        onClick={() => openAddress(address)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                      >
                        <ExternalLink className="h-3 w-3" /> Open
                      </button>
                      <button
                        type="button"
                        onClick={() => void republish(site)}
                        disabled={working}
                        className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
                      >
                        <RefreshCw className="h-3 w-3" /> Update
                      </button>
                      <button
                        type="button"
                        onClick={() => void verifySite(site.id, site.files.length)}
                        disabled={working}
                        className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
                      >
                        <FileText className="h-3 w-3" /> Check files
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(site)}
                        disabled={working}
                        title="Remove from this browser"
                        aria-label={`Remove ${site.title || site.siteId || 'root site'}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)] disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  {flow.verify?.id === site.id && resultId !== site.id ? (
                    <VerifyStatus verify={flow.verify} />
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      )}

      <details className="text-ui-105 text-[color:var(--color-muted)]">
        <summary className="cursor-pointer">How site publishing works</summary>
        <p className="mt-1.5 leading-relaxed">
          This publishes a NIP-5A site. Your files go to Blossom file servers, and a signed list
          of them (the manifest) goes to Nostr relays. Servers may delete files after a while, so
          use more than one and keep your folder. The browser does not keep a copy of the files.
        </p>
        <button
          type="button"
          onClick={() => {
            void window.ncc.newTab('nccpublish://app/')
            onClose()
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-10 hover:bg-[color:var(--color-hover)]"
        >
          <ExternalLink className="h-3 w-3" />
          Open the standalone publisher page
        </button>
      </details>
    </div>
  )
}
