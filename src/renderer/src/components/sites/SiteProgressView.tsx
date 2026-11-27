import { Check, Copy, ExternalLink, FileText, Globe } from 'lucide-react'
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../guided/ui'
import { StepHeading } from '../guided/Stepper'
import { TaskList } from '../guided/TaskList'
import {
  cancelSiteJob,
  goToSiteStep,
  publishSite,
  publishTasks,
  resetSiteFlow,
  verifySite,
  type PublishJob,
  type VerifyJob
} from './siteFlow'
import { VerifyStatus } from './VerifyStatus'

interface SiteProgressViewProps {
  job: PublishJob
  log: string[]
  verify: VerifyJob | null
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  onOpen: (address: string) => void
}

/** The publishing step: live stages while it runs, then what happened. */
export function SiteProgressView({ job, log, verify, copied, copy, onOpen }: SiteProgressViewProps) {
  const result = job.result
  const refused = result?.reports.filter((report) => !report.ok) ?? []
  return (
    <div className="space-y-3">
      <StepHeading
        title={
          job.status === 'done'
            ? 'Your site is published'
            : job.status === 'failed'
              ? 'Publishing did not finish'
              : job.status === 'cancelled'
                ? 'Publishing cancelled'
                : job.cancelling
                  ? 'Cancelling…'
                  : 'Publishing your site'
        }
      >
        {job.status === 'running'
          ? 'Keep the browser open. You can use other pages while this runs.'
          : job.status === 'done'
            ? 'Anyone with this address can open it.'
            : 'The site was not announced. Files already uploaded stay on the file servers.'}
      </StepHeading>

      {job.status === 'done' && result ? (
        <div
          data-nsite-result
          className="space-y-2 rounded-xl border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/5 p-3"
        >
          <p className="flex items-start gap-2 break-all font-mono text-ui-11 text-[color:var(--color-text)]">
            <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-accent)]" />
            {result.address}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onOpen(result.address)} className={PRIMARY_BUTTON}>
              <ExternalLink className="h-3.5 w-3.5" /> Open site
            </button>
            <button
              type="button"
              onClick={() => void copy('result', result.address)}
              className={SECONDARY_BUTTON}
            >
              {copied === 'result' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied === 'result' ? 'Copied' : 'Copy address'}
            </button>
            <button
              type="button"
              disabled={verify?.running}
              onClick={() => void verifySite(result.site.id, result.site.files.length)}
              className={SECONDARY_BUTTON}
            >
              <FileText className="h-3.5 w-3.5" /> Check uploaded files
            </button>
          </div>
          {verify && verify.id === result.site.id ? <VerifyStatus verify={verify} /> : null}
          <p className="text-ui-105 text-[color:var(--color-muted)]">
            {result.site.files.length} files on {result.site.servers.length} file server
            {result.site.servers.length === 1 ? '' : 's'} · accepted by{' '}
            {result.reports.length - refused.length} of {result.reports.length} relays
          </p>
          {refused.length > 0 ? (
            <details className="text-ui-105 text-[color:var(--color-muted)]">
              <summary className="cursor-pointer">
                Some relays did not accept it. The site still works from the others.
              </summary>
              {refused.map((report) => (
                <p key={report.relay} className="mt-0.5 break-all">
                  {report.relay}: {report.message}
                </p>
              ))}
            </details>
          ) : null}
        </div>
      ) : (
        <TaskList tasks={publishTasks(job)} />
      )}

      {log.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-ui-105 text-[color:var(--color-muted)]">
            Technical details
          </summary>
          <div className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-[color:var(--color-ink)]/60 p-2 font-mono text-ui-95 text-[color:var(--color-muted)]">
            {log.map((entry, index) => (
              <div key={`${index}-${entry}`} className="break-all">
                {entry}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {job.status === 'running' ? (
          <button
            type="button"
            disabled={job.cancelling}
            onClick={() => void cancelSiteJob()}
            className={SECONDARY_BUTTON}
          >
            Cancel
          </button>
        ) : job.status === 'done' ? (
          <button type="button" onClick={resetSiteFlow} className={SECONDARY_BUTTON}>
            Publish another site
          </button>
        ) : (
          <>
            {job.error?.includes('Choose the folder again') ? (
              <button type="button" onClick={() => goToSiteStep(0)} className={PRIMARY_BUTTON}>
                Choose folder again
              </button>
            ) : (
              <button type="button" onClick={() => void publishSite()} className={PRIMARY_BUTTON}>
                Try again
              </button>
            )}
            <button type="button" onClick={() => goToSiteStep(2)} className={SECONDARY_BUTTON}>
              Back to check
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Discard this site setup and start over?')) resetSiteFlow()
              }}
              className={QUIET_BUTTON}
            >
              Start over
            </button>
          </>
        )}
      </div>
    </div>
  )
}
