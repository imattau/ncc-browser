import type { CertificateFieldsProps } from './CertificateFields'
import { EndpointFields, type EndpointFieldsProps } from './EndpointFields'
import { ServiceAdvancedFields } from './ServiceAdvancedFields'
import type { DraftState } from './types'
import { FIELD_LABEL, INPUT, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../guided/ui'

interface ServiceDraftFormProps {
  draft: DraftState
  patchDraft: (patch: Partial<DraftState>) => void
  busy: boolean
  error: string | null
  strictAnchors: boolean
  identityConfigured: boolean
  draftAddress: string
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  endpoint: EndpointFieldsProps
  certificate: CertificateFieldsProps
  onSubmit: () => void
  onCancel: () => void
  onLater: () => void
}

/** Edit a saved service: everything on one page. New services use the wizard. */
export function ServiceDraftForm({
  draft,
  patchDraft,
  busy,
  error,
  strictAnchors,
  identityConfigured,
  draftAddress,
  copied,
  copy,
  endpoint,
  certificate,
  onSubmit,
  onCancel,
  onLater
}: ServiceDraftFormProps) {
  return (
    <form
      data-service-edit
      className="space-y-3 rounded-xl border border-[color:var(--color-accent)]/30 bg-[color:var(--color-field)] p-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label className={FIELD_LABEL}>
        Name
        <input
          value={draft.title}
          onChange={(event) => patchDraft({ title: event.target.value })}
          placeholder="Photos"
          className={INPUT}
        />
      </label>

      {draftAddress ? (
        <button
          type="button"
          onClick={() => void copy('draft-address', draftAddress)}
          className="block max-w-full break-all text-left font-mono text-ui-105 text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
        >
          {copied === 'draft-address' ? 'copied' : draftAddress}
        </button>
      ) : null}

      <EndpointFields {...endpoint} />

      <label className={FIELD_LABEL}>
        Who can open it
        <select
          value={draft.visibility}
          onChange={(event) =>
            patchDraft({ visibility: event.target.value === 'public' ? 'public' : 'private' })
          }
          className={INPUT}
        >
          <option value="private">Only me, and people I choose</option>
          <option value="public">Anyone with the address (public)</option>
        </select>
      </label>

      <label className={FIELD_LABEL}>
        Note (optional, shown to people you share with)
        <input
          value={draft.notes}
          onChange={(event) => patchDraft({ notes: event.target.value })}
          maxLength={280}
          className={INPUT}
        />
      </label>

      <details
        open={Object.keys(draft.pins).length > 0}
        className="rounded-lg border border-[color:var(--color-line)] p-2.5"
      >
        <summary className="cursor-pointer text-ui-11 text-[color:var(--color-muted)]">
          More options: validity, trust record and certificate
        </summary>
        <div className="mt-2.5 space-y-3">
          <ServiceAdvancedFields
            draft={draft}
            patchDraft={patchDraft}
            strictAnchors={strictAnchors}
            certificate={certificate}
          />
        </div>
      </details>

      <p className="text-ui-105 text-[color:var(--color-muted)]">
        After saving, press Publish on the card to send your changes.
      </p>
      {error ? (
        <p role="alert" className="text-ui-11 text-[color:var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !identityConfigured} className={PRIMARY_BUTTON}>
          Save changes
        </button>
        <button type="button" onClick={onLater} className={SECONDARY_BUTTON}>
          Finish later
        </button>
        <button type="button" onClick={onCancel} className={QUIET_BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  )
}
