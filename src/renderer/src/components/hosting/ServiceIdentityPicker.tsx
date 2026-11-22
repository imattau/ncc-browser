import type { IdentityStatus } from '@shared/types'
import { cn } from '../../lib/cn'
import { shortIdentity } from '../../lib/format'
import type { HostingIdentityApi } from './useHostingIdentity'

interface ServiceIdentityPickerProps {
  identity: IdentityStatus | null
  identityAdmin: HostingIdentityApi
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
}

/** The identity that will sign a new service, including the one-off key flow. */
export function ServiceIdentityPicker({
  identity,
  identityAdmin,
  copied,
  copy
}: ServiceIdentityPickerProps) {
  const {
    identityList,
    identityBusy,
    ephemeralNsec,
    addIdentityToList,
    setAddIdentityToList,
    selectIdentity,
    createIdentity,
    saveEphemeral,
    revealEphemeral,
    discardEphemeral
  } = identityAdmin
  const alreadyListed = identityList?.identities.some(
    (entry) => entry.hexPubkey === identity?.hexPubkey
  )

  return (
    <div data-service-identity className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-ui-105 font-semibold text-[color:var(--color-text-strong)]">
            Signing identity
          </p>
          <p className="text-ui-95 leading-relaxed text-[color:var(--color-muted)]">
            The active identity signs this service. Pick an existing one, or create a new one.
          </p>
          {identityList && identityList.identities.length > 0 ? (
            <select
              data-service-identity-select
              value={identity?.source === 'session' ? 'session' : (identity?.hexPubkey ?? '')}
              disabled={identityBusy}
              onChange={(event) => void selectIdentity(event.target.value)}
              className="mt-1 w-full max-w-md rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2 py-1 text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
            >
              {identity?.source === 'session' ? (
                <option value="session">
                  One-off · {identity.npub ? shortIdentity(identity.npub) : 'session only'}
                </option>
              ) : null}
              {identityList.identities.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {(entry.npub ? shortIdentity(entry.npub) : entry.id.slice(0, 12)) +
                    ` · ${entry.mode}${entry.persisted ? '' : ' · session'}`}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-1 text-ui-105 text-[color:var(--color-muted)]">
              {identity?.npub ? shortIdentity(identity.npub) : 'No identity yet'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-ui-95 text-[color:var(--color-muted)]">
            <input
              type="checkbox"
              checked={addIdentityToList}
              onChange={(event) => setAddIdentityToList(event.target.checked)}
              className="h-3.5 w-3.5 accent-[color:var(--color-accent)]"
            />
            Add to identity list
          </label>
          <button
            type="button"
            disabled={identityBusy}
            onClick={() => void createIdentity()}
            className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-105 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            New identity
          </button>
        </div>
      </div>
      {identity?.source === 'session' ? (
        <div className="mt-2 rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2 py-1.5">
          <p className="text-ui-95 text-[color:var(--color-muted)]">
            This one-off identity is not saved. Copy its nsec now if you may need to renew or
            share this service after the app closes. Discarding it leaves the service signed by
            a key you no longer have.
          </p>
          {ephemeralNsec ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all font-mono text-ui-95 text-[color:var(--color-text)]">
                {ephemeralNsec}
              </code>
              <button
                type="button"
                onClick={() => void copy('ephemeral-nsec', ephemeralNsec)}
                className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
              >
                {copied === 'ephemeral-nsec' ? 'copied' : 'Copy nsec'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void revealEphemeral()}
              className="mt-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
            >
              Show nsec
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <label
              className={cn(
                'flex items-center gap-1.5 text-ui-95',
                alreadyListed
                  ? 'cursor-not-allowed text-[color:var(--color-faint)]'
                  : 'cursor-pointer text-[color:var(--color-muted)]'
              )}
            >
              <input
                type="checkbox"
                data-add-one-off
                checked={Boolean(alreadyListed)}
                disabled={identityBusy || Boolean(alreadyListed)}
                onChange={(event) => {
                  if (event.target.checked) void saveEphemeral()
                }}
                className="h-3.5 w-3.5 accent-[color:var(--color-accent)]"
              />
              Add to identity list
              {alreadyListed ? ' (already added)' : ''}
            </label>
            <button
              type="button"
              disabled={identityBusy}
              onClick={() => void discardEphemeral()}
              className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-95 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)] disabled:opacity-50"
            >
              Discard one-off identity
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
