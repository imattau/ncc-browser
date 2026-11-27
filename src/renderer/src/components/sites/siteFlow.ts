import {
  validateNsiteSiteId,
  type NsiteFolderScan,
  type NsiteProgress,
  type NsitePublishInput,
  type NsitePublishResult,
  type NsiteVerifyResult,
  type PublishedNsite
} from '@shared/nsite-publish'
import { createDraftKeeper } from '../../lib/draft-keeper'
import { createJobStore } from '../../lib/job-store'
import { messageOf } from '../../lib/format'
import { suggestSiteId, suggestSiteTitle } from '../../lib/publish-flow'
import type { Task, TaskStatus } from '../guided/tasks'

export const DEFAULT_SERVERS = [
  'https://blossom.ditto.pub',
  'https://nostr.download',
  'https://blossom.primal.net'
]

export interface SiteDraft {
  root: boolean
  siteId: string
  title: string
  description: string
  source: string
  serverText: string
  relayText: string
}

export const EMPTY_DRAFT: SiteDraft = {
  root: false,
  siteId: '',
  title: '',
  description: '',
  source: '',
  serverText: DEFAULT_SERVERS.join('\n'),
  relayText: ''
}

export type PublishStage = 'upload' | 'sign' | 'send'

export interface PublishJob {
  status: 'running' | 'done' | 'failed' | 'cancelled'
  stage: PublishStage
  uploaded: number
  total: number
  current?: string
  cancelling?: boolean
  result?: NsitePublishResult
  error?: string
}

export interface VerifyJob {
  id: string
  running: boolean
  done: number
  total: number
  result?: NsiteVerifyResult
  error?: string
}

export interface SiteFlow {
  /** 0 choose a folder, 1 name the site, 2 check and publish. */
  step: 0 | 1 | 2
  scan: NsiteFolderScan | null
  draft: SiteDraft
  /** Set once the user types, so a new folder stops replacing their wording. */
  titleEdited: boolean
  idEdited: boolean
  /** The site being updated, when the flow started from Republish. */
  updating: PublishedNsite | null
  job: PublishJob | null
  log: string[]
  verify: VerifyJob | null
  /** Details kept from before the browser closed, waiting for the folder again. */
  recovered: { folderName: string; publishing: boolean } | null
}

const INITIAL: SiteFlow = {
  step: 0,
  scan: null,
  draft: EMPTY_DRAFT,
  titleEdited: false,
  idEdited: false,
  updating: null,
  job: null,
  log: [],
  verify: null,
  recovered: null
}

export const siteFlow = createJobStore<SiteFlow>(INITIAL)

export function lines(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))]
}

export function siteIdProblem(draft: SiteDraft): string | null {
  if (draft.root) return null
  return draft.siteId.trim()
    ? validateNsiteSiteId(draft.siteId)
    : 'Enter a short name for the address.'
}

const STAGES: Record<NsiteProgress['phase'], PublishStage | null> = {
  uploading: 'upload',
  signing: 'sign',
  publishing: 'send',
  verifying: null
}

function receiveProgress(progress: NsiteProgress): void {
  siteFlow.set((flow) => {
    const log = progress.log ? [...flow.log.slice(-100), progress.log] : flow.log
    if (progress.phase === 'verifying') {
      return flow.verify?.running
        ? { ...flow, log, verify: { ...flow.verify, done: progress.done, total: progress.total } }
        : flow
    }
    const stage = STAGES[progress.phase]
    if (!stage || flow.job?.status !== 'running') return { ...flow, log }
    return {
      ...flow,
      log,
      job: {
        ...flow.job,
        stage,
        ...(stage === 'upload'
          ? {
              uploaded: progress.done,
              total: progress.total,
              current: progress.current ?? flow.job.current
            }
          : {})
      }
    }
  })
}

let listening = false

/** Subscribes once for the life of the window, not of the screen. */
export function listenForSiteProgress(): void {
  if (listening) return
  listening = true
  window.ncc.onNsiteProgress(receiveProgress)
}

/** A file check in progress must stay in view, with its Cancel button. */
function stillRunning(verify: VerifyJob | null): VerifyJob | null {
  return verify?.running ? verify : null
}

/** Choose a folder. With `site`, start an update of that published site. */
export async function pickSiteFolder(site?: PublishedNsite): Promise<void> {
  const scan = await window.ncc.nsitePickFolder()
  if (!scan) return
  siteFlow.set((flow) => {
    const usable = scan.problems.length === 0
    const cleared = {
      ...flow,
      scan,
      job: null,
      log: [],
      verify: stillRunning(flow.verify),
      recovered: null
    }
    if (site) {
      return {
        ...cleared,
        step: usable ? 2 : 0,
        updating: site,
        titleEdited: true,
        idEdited: true,
        draft: {
          root: site.siteId === null,
          siteId: site.siteId ?? '',
          title: site.title ?? '',
          description: site.description ?? '',
          source: site.source ?? '',
          serverText: site.servers.join('\n') || DEFAULT_SERVERS.join('\n'),
          relayText: flow.draft.relayText
        }
      }
    }
    const title = flow.titleEdited ? flow.draft.title : suggestSiteTitle(scan.folderName)
    return {
      ...cleared,
      step: usable ? 1 : 0,
      draft: {
        ...flow.draft,
        title,
        siteId: flow.idEdited ? flow.draft.siteId : suggestSiteId(title)
      }
    }
  })
}

export function patchSiteDraft(patch: Partial<SiteDraft>): void {
  siteFlow.set((flow) => {
    const draft = { ...flow.draft, ...patch }
    const idEdited = flow.idEdited || patch.siteId !== undefined
    if (patch.title !== undefined && !idEdited) draft.siteId = suggestSiteId(patch.title)
    return {
      ...flow,
      draft,
      idEdited,
      titleEdited: flow.titleEdited || patch.title !== undefined
    }
  })
}

export function goToSiteStep(step: SiteFlow['step']): void {
  siteFlow.set((flow) => ({ ...flow, step, job: null }))
}

/** Start over, keeping the servers and relays the user chose. */
export function resetSiteFlow(): void {
  siteFlow.set((flow) => ({
    ...INITIAL,
    verify: stillRunning(flow.verify),
    draft: {
      ...EMPTY_DRAFT,
      serverText: flow.draft.serverText,
      relayText: flow.draft.relayText
    }
  }))
}

export async function publishSite(): Promise<void> {
  const { scan, draft, job, verify } = siteFlow.get()
  if (!scan || job?.status === 'running' || verify?.running) return
  const input: NsitePublishInput = {
    token: scan.token,
    siteId: draft.root ? null : draft.siteId,
    title: draft.title,
    description: draft.description,
    source: draft.source,
    servers: lines(draft.serverText),
    relays: lines(draft.relayText)
  }
  siteFlow.set((flow) => ({
    ...flow,
    log: [],
    verify: null,
    job: { status: 'running', stage: 'upload', uploaded: 0, total: scan.files.length }
  }))
  const finish = (patch: Partial<PublishJob>): void =>
    siteFlow.set((flow) => (flow.job ? { ...flow, job: { ...flow.job, ...patch } } : flow))
  try {
    const next = await window.ncc.nsitePublish(input)
    if ('cancelled' in next) finish({ status: 'cancelled' })
    else finish({ status: 'done', stage: 'send', uploaded: scan.files.length, result: next })
  } catch (error) {
    finish({ status: 'failed', error: messageOf(error) })
  }
}

export async function verifySite(id: string, total: number): Promise<void> {
  const { job, verify } = siteFlow.get()
  if (job?.status === 'running' || verify?.running) return
  siteFlow.set((flow) => ({ ...flow, verify: { id, running: true, done: 0, total } }))
  const finish = (patch: Partial<VerifyJob> | null): void =>
    siteFlow.set((flow) => ({
      ...flow,
      verify: patch && flow.verify ? { ...flow.verify, running: false, ...patch } : null
    }))
  try {
    const next = await window.ncc.nsiteVerify(id)
    finish('cancelled' in next ? null : { result: next })
  } catch (error) {
    finish({ error: messageOf(error) })
  }
}

export async function cancelSiteJob(): Promise<void> {
  if (!(await window.ncc.nsiteCancel())) return
  siteFlow.set((flow) =>
    flow.job?.status === 'running' ? { ...flow, job: { ...flow.job, cancelling: true } } : flow
  )
}

/** The publish job as the three stages shown to the user. */
const ORDER: PublishStage[] = ['upload', 'sign', 'send']

export function publishTasks(job: PublishJob): Task[] {
  const at = ORDER.indexOf(job.stage)
  const statusOf = (index: number): TaskStatus => {
    if (job.status === 'done' || index < at) return 'done'
    if (index > at) return 'pending'
    if (job.status === 'running') return 'running'
    return job.status === 'failed' ? 'failed' : 'skipped'
  }
  const hints: Record<PublishStage, string | undefined> = {
    upload: job.current,
    sign: 'If you use a remote signer, approve the request there.',
    send: 'Waiting for the relays to answer.'
  }
  const labels: Record<PublishStage, string> = {
    upload: 'Upload your files',
    sign: 'Sign with your identity',
    send: 'Announce the site to relays'
  }
  return ORDER.map((stage, index) => {
    const status = statusOf(index)
    const detail =
      status === 'running' ? hints[stage] : status === 'failed' ? job.error : undefined
    return {
      key: stage,
      label: labels[stage],
      status,
      ...(detail ? { detail } : {}),
      ...(stage === 'upload' ? { progress: { done: job.uploaded, total: job.total } } : {})
    }
  })
}

/** Whether the user has put in anything that would be a loss. */
export function worthKeeping(flow: SiteFlow): boolean {
  if (flow.job?.status === 'done') return false
  const { draft } = flow
  return Boolean(
    flow.job ||
      flow.updating ||
      flow.titleEdited ||
      flow.idEdited ||
      draft.root ||
      draft.description ||
      draft.source ||
      draft.serverText !== EMPTY_DRAFT.serverText
  )
}

const keeper = createDraftKeeper('site')
let written: string | null = null
let restoring: Promise<void> | null = null

/** What is written to disk. The folder itself is not: it has to be chosen again. */
function kept(flow: SiteFlow): Record<string, unknown> {
  return {
    version: 1,
    draft: flow.draft,
    titleEdited: flow.titleEdited,
    idEdited: flow.idEdited,
    updating: flow.updating ? { ...flow.updating, files: [] } : null,
    folderName: flow.scan?.folderName ?? flow.recovered?.folderName ?? '',
    publishing: flow.job ? flow.job.status === 'running' : Boolean(flow.recovered?.publishing)
  }
}

siteFlow.subscribe(() => {
  const flow = siteFlow.get()
  if (worthKeeping(flow)) {
    const next = kept(flow)
    const text = JSON.stringify(next)
    // Upload progress changes the flow constantly but nothing that is kept.
    if (text === written) return
    written = text
    keeper.save(next)
  } else if (written !== null) {
    written = null
    keeper.save(null)
  }
})

/** Read a kept setup back, trusting nothing about the file's contents. */
export function parseKeptSite(raw: unknown): Partial<SiteFlow> | null {
  const value = raw as Record<string, unknown> | null
  const draft = value?.draft as Partial<SiteDraft> | undefined
  if (value?.version !== 1 || !draft) return null
  const text = [draft.siteId, draft.title, draft.description, draft.source, draft.serverText, draft.relayText]
  if (!text.every((entry) => typeof entry === 'string')) return null
  const updating = value.updating as PublishedNsite | null
  return {
    draft: { ...(draft as SiteDraft), root: draft.root === true },
    titleEdited: value.titleEdited === true,
    idEdited: value.idEdited === true,
    updating: updating && typeof updating.owner === 'string' ? { ...updating, files: [] } : null,
    recovered: {
      folderName: typeof value.folderName === 'string' ? value.folderName : '',
      publishing: value.publishing === true
    }
  }
}

/** Bring back a setup kept by an earlier run, once per window. */
export function restoreSiteFlow(): Promise<void> {
  restoring ??= keeper.load().then((raw) => {
    const previous = parseKeptSite(raw)
    const current = siteFlow.get()
    if (!previous || current.scan || worthKeeping(current)) return
    written = ''
    siteFlow.set({ ...current, ...previous })
  })
  return restoring
}
