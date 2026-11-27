import { Check, Copy, ExternalLink, Users } from 'lucide-react'
import { recipientNpub, serviceAddress, type HostingState } from '@shared/hosting'
import { checkAddresses } from '../../lib/publish-flow'
import { StepHeading, Stepper } from '../guided/Stepper'
import { TaskList } from '../guided/TaskList'
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../guided/ui'
import { dismissServiceSetup, resumeServiceSetup, type SetupJob } from './serviceSetup'
import { SERVICE_STEPS } from './ServiceWizard'

interface ServiceSetupProgressProps {
  job: SetupJob
  state: HostingState
  npub: string
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  onOpen: (address: string) => void
  onShare: (serviceId: string) => void
}

/** What happens after the last step, and what the user can do next. */
export function ServiceSetupProgress({
  job,
  state,
  npub,
  copied,
  copy,
  onOpen,
  onShare
}: ServiceSetupProgressProps) {
  const service = state.services.find(({ id }) => id === job.serviceId)
  const owner = service?.owner ? recipientNpub(service.owner) : npub
  const address = service && owner ? serviceAddress(owner, service.service) : ''
  const failed = job.tasks.find((task) => task.status === 'failed')
  const published = job.tasks.some((task) => task.key === 'publish' && task.status === 'done')
  const done = job.status === 'done'
  const isPrivate = service?.visibility === 'private'
  const onlyHere =
    !service ||
    service.endpoints.length === 0 ||
    checkAddresses(service.endpoints.map(({ url }) => url).join('\n')).onlyLoopback

  let outcome = ''
  if (done && !published) {
    outcome = 'Saved, but not published, so the address does not work yet. Publish it from its card.'
  } else if (done && isPrivate && onlyHere) {
    outcome =
      'Published, but only this computer can open it. To let others in, use “Tor address” on its card, or edit it to add a network address.'
  } else if (done && isPrivate) {
    outcome = 'Right now only you can open it. Choose who else gets access.'
  } else if (done) {
    outcome = 'Anyone with this address can open it, as long as your app is running and reachable.'
  }

  return (
    <div
      data-service-setup={job.status}
      className="space-y-3 rounded-xl border border-[color:var(--color-accent)]/30 bg-[color:var(--color-field)] p-3.5"
    >
      <Stepper steps={SERVICE_STEPS} current={SERVICE_STEPS.length} />
      <StepHeading
        title={
          job.status === 'running'
            ? `Setting up “${job.title}”`
            : failed
              ? `“${job.title}” is not finished`
              : published
                ? `“${job.title}” is published`
                : `“${job.title}” is saved`
        }
      >
        {job.status === 'running'
          ? 'Keep the browser open. You can use other pages while this runs.'
          : failed
            ? job.serviceId
              ? 'Your service is saved. You can try the failed part again now, or later from its card.'
              : 'Nothing was saved.'
            : outcome}
      </StepHeading>

      <TaskList tasks={job.tasks} />

      {done && published && address ? (
        <p className="break-all rounded-lg border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/5 px-2.5 py-2 font-mono text-ui-11 text-[color:var(--color-text)]">
          {address}
        </p>
      ) : null}

      {job.status === 'running' ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {failed ? (
            <>
              <button type="button" onClick={() => void resumeServiceSetup()} className={PRIMARY_BUTTON}>
                Try again
              </button>
              {failed.key === 'tor' ? (
                <button
                  type="button"
                  data-setup-skip
                  onClick={() => void resumeServiceSetup(true)}
                  className={SECONDARY_BUTTON}
                >
                  Continue without Tor
                </button>
              ) : null}
              <button type="button" onClick={dismissServiceSetup} className={QUIET_BUTTON}>
                {job.serviceId ? 'Close' : 'Back to editing'}
              </button>
            </>
          ) : (
            <>
              {published && isPrivate && !onlyHere && service ? (
                <button
                  type="button"
                  data-setup-share
                  onClick={() => {
                    dismissServiceSetup()
                    onShare(service.id)
                  }}
                  className={PRIMARY_BUTTON}
                >
                  <Users className="h-3.5 w-3.5" /> Choose people
                </button>
              ) : null}
              {published && address ? (
                <>
                  <button type="button" onClick={() => onOpen(address)} className={SECONDARY_BUTTON}>
                    <ExternalLink className="h-3.5 w-3.5" /> Open
                  </button>
                  <button
                    type="button"
                    onClick={() => void copy('setup-address', address)}
                    className={SECONDARY_BUTTON}
                  >
                    {copied === 'setup-address' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied === 'setup-address' ? 'Copied' : 'Copy address'}
                  </button>
                </>
              ) : null}
              <button type="button" data-setup-done onClick={dismissServiceSetup} className={SECONDARY_BUTTON}>
                Done
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
