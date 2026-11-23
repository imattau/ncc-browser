import type { IdentityStatus } from '@shared/types'
import { CertificateFields, type CertificateFieldsProps } from './CertificateFields'
import { EndpointFields, type EndpointFieldsProps } from './EndpointFields'
import { ServiceIdentityPicker } from './ServiceIdentityPicker'
import type { DraftState } from './types'
import type { HostingIdentityApi } from './useHostingIdentity'

interface ServiceDraftFormProps {
  draft: DraftState
  patchDraft: (patch: Partial<DraftState>) => void
  busy: boolean
  strictAnchors: boolean
  identity: IdentityStatus | null
  draftAddress: string
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  identityAdmin: HostingIdentityApi
  endpoint: EndpointFieldsProps
  certificate: CertificateFieldsProps
  onSubmit: () => void
  onCancel: () => void
}

/** Create/edit form for one hosted service. */
export function ServiceDraftForm({
  draft,
  patchDraft,
  busy,
  strictAnchors,
  identity,
  draftAddress,
  copied,
  copy,
  identityAdmin,
  endpoint,
  certificate,
  onSubmit,
  onCancel
}: ServiceDraftFormProps) {
  return (
    <form
      className="space-y-3 rounded-xl border border-[color:var(--color-accent)]/30 bg-[color:var(--color-field)] p-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {!draft.id ? (
        <ServiceIdentityPicker
          identity={identity}
          identityAdmin={identityAdmin}
          copied={copied}
          copy={copy}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-ui-105 text-[color:var(--color-muted)]">
          Name
          <input
            value={draft.title}
            onChange={(event) => patchDraft({ title: event.target.value })}
            placeholder="Photos"
            className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
          />
        </label>
        <label className="block text-ui-105 text-[color:var(--color-muted)]">
          Service id
          <input
            value={draft.service}
            disabled={Boolean(draft.id)}
            onChange={(event) => patchDraft({ service: event.target.value })}
            placeholder="photos"
            className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)] disabled:opacity-60"
          />
        </label>
      </div>

      <div className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 px-2.5 py-1.5">
        <span className="text-ui-95 text-[color:var(--color-muted)]">Address</span>
        <button
          type="button"
          disabled={!identity?.npub || !(draft.service.trim() || draft.title.trim())}
          onClick={() => void copy('draft-address', draftAddress)}
          className="ml-2 max-w-full truncate font-mono text-ui-105 text-[color:var(--color-text)] hover:text-[color:var(--color-accent)] disabled:opacity-50"
        >
          {copied === 'draft-address' ? 'copied' : draftAddress || 'connect an identity first'}
        </button>
        <p className="mt-0.5 text-ui-95 text-[color:var(--color-faint)]">
          This address comes from your identity and the service id, not from the endpoints. You can
          save it now and add endpoints before publishing.
        </p>
      </div>

      <EndpointFields {...endpoint} />

      <CertificateFields {...certificate} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-ui-105 text-[color:var(--color-muted)]">
          Visibility
          <select
            value={draft.visibility}
            onChange={(event) =>
              patchDraft({
                visibility: event.target.value === 'public' ? 'public' : 'private'
              })
            }
            className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
          >
            <option value="private">Private (encrypted to you)</option>
            <option value="public">Public (plaintext)</option>
          </select>
        </label>
        <label className="block text-ui-105 text-[color:var(--color-muted)]">
          Locator lifetime, days
          <input
            type="number"
            min={1}
            max={30}
            value={draft.ttlDays}
            onChange={(event) => patchDraft({ ttlDays: event.target.value })}
            className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
          />
        </label>
      </div>

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

      <label className="block text-ui-105 text-[color:var(--color-muted)]">
        Note (optional, shown to people you share with)
        <input
          value={draft.notes}
          onChange={(event) => patchDraft({ notes: event.target.value })}
          maxLength={280}
          className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
        />
      </label>

      {draft.visibility === 'private' && !draft.id ? (
        <p className="text-ui-10 leading-relaxed text-[color:var(--color-faint)]">
          Adding a private service opens Share so you can pick contacts. Each recipient gets
          their own encrypted link; a loopback-only service must be reachable first.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !identity?.configured}
          className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
        >
          {draft.id ? 'Save changes' : 'Add service'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
