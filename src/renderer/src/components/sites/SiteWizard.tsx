import { AlertTriangle, ArrowLeft, FolderOpen, Globe, Upload } from 'lucide-react'
import { useState } from 'react'
import { nsiteSiteAddress, type PublishedNsite } from '@shared/nsite-publish'
import type { IdentityStatus } from '@shared/types'
import { messageOf, relativeSeconds, shortIdentity } from '../../lib/format'
import { ServiceIdentityPicker } from '../hosting/ServiceIdentityPicker'
import type { HostingIdentityApi } from '../hosting/useHostingIdentity'
import { StepHeading, Stepper } from '../guided/Stepper'
import { FIELD_HINT, FIELD_LABEL, INPUT, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../guided/ui'
import { SiteProgressView } from './SiteProgressView'
import { VerifyStatus } from './VerifyStatus'
import {
  goToSiteStep,
  lines,
  patchSiteDraft,
  pickSiteFolder,
  publishSite,
  resetSiteFlow,
  siteFlow,
  siteIdProblem,
  worthKeeping
} from './siteFlow'

const STEPS = ['Folder', 'Name', 'Check', 'Publish']

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface SiteWizardProps {
  identity: IdentityStatus | null
  identityAdmin: HostingIdentityApi
  sites: PublishedNsite[]
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  onError: (message: string | null) => void
  onOpen: (address: string) => void
  onOpenIdentity: () => void
}

/** Folder → name → check → publish. */
export function SiteWizard({
  identity,
  identityAdmin,
  sites,
  copied,
  copy,
  onError,
  onOpen,
  onOpenIdentity
}: SiteWizardProps) {
  const flow = siteFlow.use()
  const { scan, draft, job, updating } = flow
  const [picking, setPicking] = useState(false)
  const step = job ? 3 : flow.step

  const choose = async (): Promise<void> => {
    setPicking(true)
    onError(null)
    try {
      await pickSiteFolder()
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setPicking(false)
    }
  }

  /** Cancel throws away what was typed, so it asks first. */
  const cancelSetup = (): void => {
    if (
      !worthKeeping(siteFlow.get()) ||
      window.confirm('Discard this unfinished site setup? What you entered will be lost.')
    ) {
      resetSiteFlow()
    }
  }

  const owner = identity?.hexPubkey ?? ''
  const siteId = draft.root ? null : draft.siteId.trim()
  const idProblem = siteIdProblem(draft)
  const address = owner && !idProblem ? nsiteSiteAddress(owner, siteId) : ''
  const replaces = sites.find((site) => site.owner === owner && site.siteId === siteId)
  const servers = lines(draft.serverText)
  const relays = lines(draft.relayText)
  const fileSummary = scan
    ? `${scan.files.length} file${scan.files.length === 1 ? '' : 's'}, ${formatBytes(scan.totalBytes)}`
    : ''

  const fileList = scan ? (
    <details>
      <summary className="cursor-pointer text-ui-105 text-[color:var(--color-muted)]">
        See the files that will be uploaded
      </summary>
      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-[color:var(--color-ink)]/60 p-2 font-mono text-ui-95 text-[color:var(--color-muted)]">
        {scan.files.slice(0, 200).map((file) => (
          <div key={file.path} className="flex gap-2">
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            <span className="shrink-0 text-[color:var(--color-faint)]">{formatBytes(file.size)}</span>
          </div>
        ))}
        {scan.files.length > 200 ? <div>+{scan.files.length - 200} more…</div> : null}
      </div>
    </details>
  ) : null

  const replaceWarning = replaces ? (
    <p
      data-nsite-replaces
      role="status"
      className="rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-text)]"
    >
      This replaces your published site “{replaces.title || replaces.siteId || 'Main site'}”
      {replaces.lastPublishedAt ? `, published ${relativeSeconds(replaces.lastPublishedAt)}` : ''}.
      {updating ? '' : ' To keep both, choose a different short name.'}
    </p>
  ) : null

  return (
    <div
      data-nsite-wizard
      data-wizard-step={step}
      className="space-y-4 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4"
    >
      <div className="space-y-3">
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
          {updating ? `Update “${updating.title || updating.siteId || 'Main site'}”` : 'Publish a site'}
        </h3>
        <Stepper steps={STEPS} current={job?.status === 'done' ? STEPS.length : step} />
      </div>

      {job ? (
        <SiteProgressView
          job={job}
          log={flow.log}
          verify={flow.verify}
          copied={copied}
          copy={copy}
          onOpen={onOpen}
        />
      ) : step === 0 || !scan ? (
        <div className="space-y-3">
          <StepHeading title="Choose your website folder">
            Pick the folder that has <span className="font-mono">index.html</span> directly inside
            it. For a site made with a build tool, this is often called{' '}
            <span className="font-mono">dist</span> or <span className="font-mono">build</span>.
            Nothing is uploaded yet.
          </StepHeading>
          {flow.recovered ? (
            <div
              data-unfinished-site
              role="status"
              className="space-y-1 rounded-lg border border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-text)]"
            >
              <p className="font-semibold">
                Your unfinished site{draft.title ? ` “${draft.title}”` : ''} was kept.
              </p>
              <p>
                Choose {flow.recovered.folderName ? `the folder “${flow.recovered.folderName}”` : 'its folder'}{' '}
                again to continue. For safety, the browser doesn’t keep access to folders.
              </p>
              {flow.recovered.publishing ? (
                <p>
                  The browser closed while publishing, so it may not have finished. Check
                  Published sites below.
                </p>
              ) : null}
            </div>
          ) : null}
          {scan && scan.problems.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg bg-[color:var(--color-danger)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-danger)]"
            >
              <p className="font-semibold">“{scan.folderName}” can’t be published yet:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {scan.problems.slice(0, 8).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
              {scan.problems.length > 8 ? <p>+{scan.problems.length - 8} more</p> : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-nsite-pick
              disabled={picking}
              onClick={() => void choose()}
              className={PRIMARY_BUTTON}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {picking ? 'Reading folder…' : scan ? 'Choose a different folder' : 'Choose folder'}
            </button>
            {scan || updating || flow.recovered ? (
              <button type="button" data-site-discard onClick={cancelSetup} className={QUIET_BUTTON}>
                {flow.recovered ? 'Discard' : 'Cancel'}
              </button>
            ) : null}
          </div>
        </div>
      ) : step === 1 ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!idProblem) goToSiteStep(2)
          }}
        >
          <StepHeading title="Name your site">
            Found {fileSummary} in “{scan.folderName}”.
          </StepHeading>
          <label className={FIELD_LABEL}>
            Title
            <input
              value={draft.title}
              data-nsite-title
              onChange={(event) => patchSiteDraft({ title: event.target.value })}
              placeholder="My holiday photos"
              className={INPUT}
            />
          </label>
          {draft.root ? null : (
            <label className={FIELD_LABEL}>
              Short name in the address
              <input
                value={draft.siteId}
                data-nsite-site-id
                maxLength={13}
                onChange={(event) => patchSiteDraft({ siteId: event.target.value.toLowerCase() })}
                placeholder="my-photos"
                aria-invalid={Boolean(idProblem)}
                className={`${INPUT} font-mono`}
              />
              {idProblem ? (
                <span className="mt-1 block text-ui-105 text-[color:var(--color-danger)]">
                  {idProblem}
                </span>
              ) : (
                <span className={FIELD_HINT}>Up to 13 letters, numbers and dashes.</span>
              )}
            </label>
          )}
          {address ? (
            <p className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 px-2.5 py-2 text-ui-105 text-[color:var(--color-muted)]">
              Your address will be{' '}
              <span className="font-mono text-[color:var(--color-text)]">
                nsite://{shortIdentity(identity?.npub ?? owner)}/{siteId ?? ''}
              </span>
            </p>
          ) : null}
          {replaceWarning}
          <label className={FIELD_LABEL}>
            Description (optional)
            <input
              value={draft.description}
              data-nsite-description
              onChange={(event) => patchSiteDraft({ description: event.target.value })}
              className={INPUT}
            />
          </label>

          <details data-nsite-options className="rounded-lg border border-[color:var(--color-line)] p-2.5">
            <summary className="cursor-pointer text-ui-11 text-[color:var(--color-muted)]">
              More options: main site, source link, servers and relays
            </summary>
            <div className="mt-2.5 space-y-3">
              <label className="flex items-start gap-2 text-ui-11 text-[color:var(--color-text)]">
                <input
                  type="checkbox"
                  checked={draft.root}
                  onChange={(event) => patchSiteDraft({ root: event.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
                />
                <span>
                  Make this my main site
                  <span className={FIELD_HINT}>
                    Its address has no short name. Each identity has one main site.
                  </span>
                </span>
              </label>
              <label className={FIELD_LABEL}>
                Source code link (optional)
                <input
                  value={draft.source}
                  data-nsite-source
                  onChange={(event) => patchSiteDraft({ source: event.target.value })}
                  placeholder="https://github.com/you/site"
                  className={INPUT}
                />
              </label>
              <label className={FIELD_LABEL}>
                File servers (Blossom)
                <textarea
                  rows={3}
                  data-nsite-servers
                  value={draft.serverText}
                  onChange={(event) => patchSiteDraft({ serverText: event.target.value })}
                  spellCheck={false}
                  className={`${INPUT} resize-y font-mono text-ui-105`}
                />
                <span className={FIELD_HINT}>
                  These store your files. More than one is safer. The defaults are public servers.
                </span>
              </label>
              <label className={FIELD_LABEL}>
                Relays
                <textarea
                  rows={3}
                  data-nsite-relays
                  value={draft.relayText}
                  onChange={(event) => patchSiteDraft({ relayText: event.target.value })}
                  spellCheck={false}
                  className={`${INPUT} resize-y font-mono text-ui-105`}
                />
                <span className={FIELD_HINT}>These tell visitors where your files are.</span>
              </label>
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => goToSiteStep(0)} className={SECONDARY_BUTTON}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button type="submit" data-wizard-next disabled={Boolean(idProblem)} className={PRIMARY_BUTTON}>
              Continue
            </button>
            <button type="button" onClick={cancelSetup} className={QUIET_BUTTON}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <StepHeading title="Check and publish" />
          <dl className="space-y-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 p-3 text-ui-11">
            <div>
              <dt className="text-[color:var(--color-muted)]">Title</dt>
              <dd className="text-[color:var(--color-text-strong)]">{draft.title || 'No title'}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted)]">Address</dt>
              <dd className="break-all font-mono text-[color:var(--color-text)]">
                {address || idProblem || 'Set up an identity to see the address'}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted)]">Files</dt>
              <dd className="text-[color:var(--color-text)]">
                {fileSummary} from “{scan.folderName}”
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted)]">Stored and announced by</dt>
              <dd className="text-[color:var(--color-text)]">
                {servers.length} file server{servers.length === 1 ? '' : 's'},{' '}
                {relays.length > 0
                  ? `${relays.length} relay${relays.length === 1 ? '' : 's'}`
                  : 'your usual relays'}
              </dd>
            </div>
          </dl>
          {fileList}
          {replaceWarning}
          {updating && updating.owner !== owner ? (
            <p
              role="status"
              className="rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-text)]"
            >
              Another identity published this site. Publishing now makes a separate site under the
              identity below. To update the original, switch to its identity.
            </p>
          ) : null}
          <p className="flex items-start gap-2 rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-ui-11 leading-relaxed text-[color:var(--color-text)]">
            <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-warn)]" />
            <span>
              <strong>Everything in this folder becomes public.</strong> Anyone can read it, and
              copies may stay online even if you remove the site later. Check the file list for
              anything private.
            </span>
          </p>

          {identity?.configured ? (
            <ServiceIdentityPicker
              identity={identity}
              identityAdmin={identityAdmin}
              copied={copied}
              copy={copy}
              title="Publishing as"
              description="This identity signs the site, and is part of its address."
            />
          ) : (
            <p className="rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-text)]">
              Publishing needs a Nostr identity.{' '}
              <button
                type="button"
                onClick={onOpenIdentity}
                className="text-[color:var(--color-accent)] underline underline-offset-2"
              >
                Set up an identity
              </button>
              . Your choices here are kept.
            </p>
          )}

          {servers.length === 0 ? (
            <p className="flex items-center gap-2 text-ui-11 text-[color:var(--color-danger)]">
              <AlertTriangle className="h-3.5 w-3.5" /> Add at least one file server under More
              options on the Name step.
            </p>
          ) : null}
          {flow.verify?.running ? <VerifyStatus verify={flow.verify} /> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => goToSiteStep(1)} className={SECONDARY_BUTTON}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button
              type="button"
              data-nsite-publish
              disabled={
                !identity?.configured ||
                Boolean(idProblem) ||
                servers.length === 0 ||
                Boolean(flow.verify?.running)
              }
              onClick={() => {
                onError(null)
                void publishSite()
              }}
              className={PRIMARY_BUTTON}
            >
              <Upload className="h-3.5 w-3.5" /> Publish publicly
            </button>
            <button type="button" onClick={cancelSetup} className={QUIET_BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
