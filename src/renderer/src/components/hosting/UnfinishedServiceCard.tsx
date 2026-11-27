import { FilePen } from 'lucide-react'
import { relativeSeconds } from '../../lib/format'
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../guided/ui'
import type { UnfinishedService } from './serviceDraft'

interface UnfinishedServiceCardProps {
  entry: UnfinishedService
  warnings: string[]
  onContinue: () => void
  onDiscard: () => void
}

/** A form that was set aside, or kept from before the browser closed. */
export function UnfinishedServiceCard({
  entry,
  warnings,
  onContinue,
  onDiscard
}: UnfinishedServiceCardProps) {
  const name = entry.draft.title.trim() || 'Unnamed service'
  return (
    <div
      data-unfinished-service
      className="space-y-2 rounded-xl border border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 p-3"
    >
      <p className="flex items-start gap-2 text-ui-12 text-[color:var(--color-text-strong)]">
        <FilePen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-warn)]" />
        <span>
          <strong>
            {entry.draft.id ? 'Unsaved changes to' : 'Unfinished service:'} “{name}”
          </strong>
          <span className="block text-ui-105 text-[color:var(--color-muted)]">
            Not saved as a service yet
            {entry.savedAt ? `. Last changed ${relativeSeconds(Math.floor(entry.savedAt / 1000))}` : ''}.
          </span>
        </span>
      </p>
      <DraftWarnings warnings={warnings} />
      <div className="flex flex-wrap gap-2">
        <button type="button" data-unfinished-continue onClick={onContinue} className={PRIMARY_BUTTON}>
          Continue
        </button>
        <button type="button" data-unfinished-discard onClick={onDiscard} className={SECONDARY_BUTTON}>
          Discard
        </button>
      </div>
    </div>
  )
}

/** Things that may have changed since the form was last open. */
export function DraftWarnings({ warnings }: { warnings: string[] }) {
  return warnings.map((warning) => (
    <p key={warning} data-draft-warning role="status" className="text-ui-11 text-[color:var(--color-text)]">
      {warning}
    </p>
  ))
}
