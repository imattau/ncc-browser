import type { IdentityProfile, IdentityStatus } from '@shared/types'
import { useState } from 'react'
import { cn } from '../../lib/cn'
import { shortIdentity } from '../../lib/format'
import { IdentityAvatar, IdentityLabels } from '../IdentityVisual'
import { useIdentityProfileMetadata } from '../../hooks/useIdentityProfileMetadata'
import type { HostingIdentityApi } from './useHostingIdentity'

interface ServiceIdentityPickerProps {
  identity: IdentityStatus | null
  identityAdmin: HostingIdentityApi
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  title?: string
  description?: string
}

/** The identity that will sign a new service, including the one-off key flow. */
export function ServiceIdentityPicker({
  identity,
  identityAdmin,
  copied,
  copy,
  title = 'Signing identity',
  description = 'The active identity signs this service. Pick an existing one, or create a new one.'
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
  const profiles = identityList?.identities ?? []
  const metadata = useIdentityProfileMetadata(profiles)
  const [pickerOpen, setPickerOpen] = useState(false)
  const selected = profiles.find((entry) => entry.hexPubkey === identity?.hexPubkey)
  const choose = (value: string) => { setPickerOpen(false); if (value !== 'session') void selectIdentity(value) }

  return (
    <div data-service-identity className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-ui-105 font-semibold text-[color:var(--color-text-strong)]">
            {title}
          </p>
          <p className="text-ui-95 leading-relaxed text-[color:var(--color-muted)]">
            {description}
          </p>
          {identityList && identityList.identities.length > 0 ? (
            <div className="relative mt-1 w-full max-w-md" data-service-identity>
              <button type="button" data-service-identity-select aria-haspopup="listbox" aria-expanded={pickerOpen} disabled={identityBusy} onClick={() => setPickerOpen(!pickerOpen)} className="flex w-full items-center gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2 py-1.5 text-left disabled:opacity-50">
                <IdentityAvatar profile={identity?.source === 'session' ? undefined : selected ? metadata[selected.hexPubkey] : undefined} fallback={identity?.npub ?? 'No identity'} size="h-8 w-8" />
                <IdentityLabels profile={selected ? metadata[selected.hexPubkey] : undefined} npub={identity?.npub} fallback={identity?.npub ? shortIdentity(identity.npub) : 'No identity'} detail={identity?.source === 'session' ? 'One-off identity' : selected ? `${selected.mode}${selected.persisted ? '' : ' · session'}` : undefined} />
                <span aria-hidden="true">▾</span>
              </button>
              {pickerOpen ? <div role="listbox" aria-label="Signing identity" className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-1 shadow-xl">
                {identity?.source === 'session' ? <button role="option" aria-selected="true" type="button" onClick={() => choose('session')} className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-[color:var(--color-hover)]"><IdentityAvatar fallback={identity.npub ?? 'One-off'} size="h-8 w-8" /><IdentityLabels npub={identity.npub} fallback="One-off identity" detail="One-off · session only" /></button> : null}
                {profiles.map((entry: IdentityProfile) => <button key={entry.id} role="option" aria-selected={entry.id === selected?.id} type="button" onClick={() => choose(entry.id)} className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-[color:var(--color-hover)]"><IdentityAvatar profile={metadata[entry.hexPubkey]} fallback={entry.npub ?? entry.id} size="h-8 w-8" /><IdentityLabels profile={metadata[entry.hexPubkey]} npub={entry.npub} fallback={entry.id} detail={`${entry.mode}${entry.persisted ? '' : ' · session'}`} /></button>)}
              </div> : null}
            </div>
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
