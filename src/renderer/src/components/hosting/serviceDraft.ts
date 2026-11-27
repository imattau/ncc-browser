import type { CertificateInfo, HostingDraft } from '@shared/hosting'
import { createDraftKeeper } from '../../lib/draft-keeper'
import { createJobStore } from '../../lib/job-store'
import type { DraftState } from './types'

/** A page sent to the service form. */
export type PrefillDraft = HostingDraft & {
  /** From a private or Tor tab, so it must not be written to disk. */
  fromPrivateTab?: boolean
}

/** The service form that has not been saved or cancelled yet. There is one at a time. */
export interface UnfinishedService {
  /** Tells one form from the next. */
  key: string
  draft: DraftState
  step: number
  wantTor: boolean
  certificate: { info: CertificateInfo; paths: { certPath: string; keyPath: string } | null } | null
  /** An address added by mapping a router port, which ends when the browser quits. */
  mappedUrl: string | null
  /** For an edit: the service's `updatedAt` when editing began. */
  baseUpdatedAt: number | null
  /** The user has put something in, so it is worth keeping. */
  dirty: boolean
  /** Kept in memory only. */
  memoryOnly: boolean
  /** Set aside: shown as a card to continue, with the service list in view. */
  parked: boolean
  savedAt: number
}

export const serviceDraft = createJobStore<UnfinishedService | null>(null)

const keeper = createDraftKeeper('service')
/** The key of the form that is on disk, so another one never erases it by accident. */
let writtenKey: string | null = null
let restoring: Promise<void> | null = null

function write(entry: UnfinishedService): void {
  if (!entry.dirty || entry.memoryOnly) return
  writtenKey = entry.key
  const { dirty: _dirty, memoryOnly: _memory, parked: _parked, ...kept } = entry
  keeper.save({ version: 1, ...kept })
}

function update(change: (entry: UnfinishedService) => UnfinishedService): void {
  const entry = serviceDraft.get()
  if (!entry) return
  const next = change(entry)
  if (next === entry) return
  serviceDraft.set(next)
  write(next)
}

export function openServiceDraft(
  draft: DraftState,
  options: { memoryOnly?: boolean; baseUpdatedAt?: number } = {}
): void {
  discardServiceDraft()
  serviceDraft.set({
    key: crypto.randomUUID(),
    draft,
    step: 0,
    wantTor: false,
    certificate: null,
    mappedUrl: null,
    baseUpdatedAt: options.baseUpdatedAt ?? null,
    dirty: false,
    memoryOnly: options.memoryOnly === true,
    parked: false,
    savedAt: Date.now()
  })
}

/** Change what is in the form. This is what makes it worth keeping. */
export function editServiceDraft(change: (draft: DraftState) => DraftState): void {
  update((entry) => {
    const draft = change(entry.draft)
    return draft === entry.draft ? entry : { ...entry, draft, dirty: true, savedAt: Date.now() }
  })
}

export function setServiceDraftExtras(
  extras: Partial<Pick<UnfinishedService, 'step' | 'wantTor' | 'certificate' | 'mappedUrl'>>
): void {
  // Moving on, choosing Tor or adding a certificate is the user's work too, even on
  // a form that was filled in from a page.
  const worked = Boolean(extras.step || extras.wantTor || extras.certificate || extras.mappedUrl)
  update((entry) => ({ ...entry, ...extras, dirty: entry.dirty || worked }))
}

export function parkServiceDraft(parked: boolean): void {
  const entry = serviceDraft.get()
  if (entry) serviceDraft.set({ ...entry, parked })
}

/** Forget the form. With `key`, only if it is still that one. */
export function discardServiceDraft(key?: string): void {
  const entry = serviceDraft.get()
  if (key !== undefined && entry?.key !== key) return
  if (entry && writtenKey === entry.key) {
    writtenKey = null
    keeper.save(null)
  }
  serviceDraft.set(null)
}

function text(value: unknown): value is string {
  return typeof value === 'string'
}

/** Read a kept form back, trusting nothing about the file's contents. */
export function parseUnfinishedService(raw: unknown): UnfinishedService | null {
  const kept = raw as (Partial<UnfinishedService> & { version?: unknown }) | null
  const draft = kept?.draft
  if (kept?.version !== 1 || !text(kept.key) || !draft) return null
  const { title, service, endpoints, ttlDays, notes, pins } = draft
  if (![title, service, endpoints, ttlDays, notes].every(text)) return null
  if (!pins || typeof pins !== 'object' || !Object.values(pins).every(text)) return null
  const certificate = kept.certificate
  return {
    key: kept.key,
    draft: {
      ...(text(draft.id) ? { id: draft.id } : {}),
      title,
      service,
      endpoints,
      pins,
      ttlDays,
      visibility: draft.visibility === 'public' ? 'public' : 'private',
      anchor: draft.anchor === true,
      notes
    },
    step: kept.step === 1 || kept.step === 2 ? kept.step : 0,
    wantTor: kept.wantTor === true,
    certificate:
      certificate && text(certificate.info?.pin) && Array.isArray(certificate.info?.names)
        ? certificate
        : null,
    mappedUrl: text(kept.mappedUrl) ? kept.mappedUrl : null,
    baseUpdatedAt: typeof kept.baseUpdatedAt === 'number' ? kept.baseUpdatedAt : null,
    dirty: true,
    memoryOnly: false,
    parked: true,
    savedAt: typeof kept.savedAt === 'number' ? kept.savedAt : 0
  }
}

/** Bring back a form kept by an earlier run, once per window. */
export function restoreServiceDraft(): Promise<void> {
  restoring ??= keeper.load().then((raw) => {
    const kept = parseUnfinishedService(raw)
    if (!kept || serviceDraft.get()) return
    writtenKey = kept.key
    serviceDraft.set(kept)
  })
  return restoring
}
