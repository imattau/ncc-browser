import { CertificateFields, type CertificateFieldsProps } from './CertificateFields'
import type { DraftState } from './types'
import { FIELD_HINT, FIELD_LABEL, INPUT } from '../guided/ui'

interface ServiceAdvancedFieldsProps {
  draft: DraftState
  patchDraft: (patch: Partial<DraftState>) => void
  strictAnchors: boolean
  certificate: CertificateFieldsProps
}

/** Settings most people never need to change. */
export function ServiceAdvancedFields({
  draft,
  patchDraft,
  strictAnchors,
  certificate
}: ServiceAdvancedFieldsProps) {
  return (
    <>
      <label className={FIELD_LABEL}>
        Days the address stays valid
        <input
          type="number"
          min={1}
          max={30}
          value={draft.ttlDays}
          onChange={(event) => patchDraft({ ttlDays: event.target.value })}
          className={INPUT}
        />
        <span className={FIELD_HINT}>
          The browser renews it while it is running (the “locator lifetime”).
        </span>
      </label>

      <label className="flex items-start gap-2 text-ui-11 text-[color:var(--color-muted)]">
        <input
          type="checkbox"
          checked={draft.anchor || strictAnchors}
          disabled={strictAnchors}
          onChange={(event) => patchDraft({ anchor: event.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)] disabled:opacity-60"
        />
        {strictAnchors
          ? 'Required by Settings → General. Private services publish the anchor without the endpoint.'
          : draft.visibility === 'private'
            ? 'Also publish an NCC-02 service record without the endpoint (identity/trust anchor).'
            : 'Also publish a public NCC-02 service record (includes the endpoint; requires HTTPS).'}
      </label>

      <CertificateFields {...certificate} />
    </>
  )
}
