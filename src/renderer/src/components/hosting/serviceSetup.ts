import type { HostingDraft } from '@shared/hosting'
import { createJobStore } from '../../lib/job-store'
import { messageOf } from '../../lib/format'
import type { Task } from '../guided/tasks'
import { discardServiceDraft } from './serviceDraft'

export type SetupKey = 'save' | 'tor' | 'publish'

export interface SetupJob {
  title: string
  payload: HostingDraft
  /** Set once the service is saved. */
  serviceId: string | null
  /** The form it came from, kept until the service is saved. */
  draftKey?: string
  tasks: Task[]
  status: 'running' | 'done' | 'failed'
}

const LABELS: Record<SetupKey, string> = {
  save: 'Save your service',
  tor: 'Create a Tor address',
  publish: 'Publish the address to relays'
}

const RUNNING_HINTS: Record<SetupKey, string | undefined> = {
  save: undefined,
  tor: 'Starting Tor can take a minute or two.',
  publish: 'If you use a remote signer, approve the requests there.'
}

/** The save → Tor → publish sequence of a new service. */
export const serviceSetup = createJobStore<SetupJob | null>(null)

function setTask(key: string, patch: Partial<Task>): void {
  serviceSetup.set((job) =>
    job
      ? {
          ...job,
          tasks: job.tasks.map((task) =>
            task.key === key ? { ...task, detail: undefined, ...patch } : task
          )
        }
      : job
  )
}

async function perform(key: SetupKey): Promise<string | undefined> {
  const job = serviceSetup.get()
  if (!job) return undefined
  if (key === 'save') {
    const before = new Set((await window.ncc.hostingState()).services.map(({ id }) => id))
    const next = await window.ncc.hostingCreate(job.payload)
    const saved = next.services.find(({ id }) => !before.has(id))
    if (!saved) throw new Error('The service was not saved')
    serviceSetup.set((current) => (current ? { ...current, serviceId: saved.id } : current))
    if (job.draftKey) discardServiceDraft(job.draftKey)
    return undefined
  }
  if (!job.serviceId) throw new Error('Save the service first')
  if (key === 'tor') {
    const { onion } = await window.ncc.hostingPublishOnion(job.serviceId)
    if (onion.error) throw new Error(onion.error)
    return onion.verifiedAt
      ? 'Checked: it answers over Tor.'
      : 'Created. It has not answered over Tor yet; that can take a few minutes. Check that your app is running.'
  }
  const result = await window.ncc.hostingPublish(job.serviceId)
  const missed = result.shares.filter((share) => !share.report.ok).length
  return [
    `Accepted by ${result.accepted} of ${result.relays} relays.`,
    missed ? `${missed} private link${missed === 1 ? '' : 's'} could not be updated.` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/** Runs every task still waiting, in order, and stops at the first failure. */
async function run(): Promise<void> {
  for (;;) {
    const next = serviceSetup.get()?.tasks.find((task) => task.status === 'pending')
    if (!next) break
    const key = next.key as SetupKey
    setTask(key, { status: 'running', detail: RUNNING_HINTS[key] })
    try {
      const detail = await perform(key)
      setTask(key, { status: 'done', detail })
    } catch (error) {
      setTask(key, { status: 'failed', detail: messageOf(error) })
      serviceSetup.set((job) => (job ? { ...job, status: 'failed' } : job))
      return
    }
  }
  serviceSetup.set((job) => (job ? { ...job, status: 'done' } : job))
}

export async function startServiceSetup(
  payload: HostingDraft,
  options: { tor: boolean; publish: boolean; draftKey?: string }
): Promise<void> {
  if (serviceSetup.get()?.status === 'running') return
  const keys: SetupKey[] = ['save']
  if (options.tor) keys.push('tor')
  if (options.publish) keys.push('publish')
  serviceSetup.set({
    title: payload.title,
    payload,
    draftKey: options.draftKey,
    serviceId: null,
    status: 'running',
    tasks: keys.map((key) => ({ key, label: LABELS[key], status: 'pending' }))
  })
  await run()
}

/** Try the failed task again, or leave it out and carry on. */
export async function resumeServiceSetup(skipFailed = false): Promise<void> {
  const job = serviceSetup.get()
  if (job?.status !== 'failed') return
  serviceSetup.set({
    ...job,
    status: 'running',
    tasks: job.tasks.map((task) =>
      task.status === 'failed'
        ? { ...task, status: skipFailed ? 'skipped' : 'pending', detail: undefined }
        : task
    )
  })
  await run()
}

export function dismissServiceSetup(): void {
  if (serviceSetup.get()?.status !== 'running') serviceSetup.set(null)
}
