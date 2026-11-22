import { Check, Copy, Link2, RefreshCw, X } from 'lucide-react'
import { contactLabel, type ContactProfile } from '@shared/contacts'
import { recipientNpub, type HostedService } from '@shared/hosting'
import { cn } from '../../lib/cn'
import { shortIdentity } from '../../lib/format'
import type { HostingSharesApi } from './useHostingShares'

interface SharePanelProps {
  service: HostedService
  canShare: boolean
  busy: boolean
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  shares: HostingSharesApi
}

/** Contact picker and result list for one private service. */
export function SharePanel({ service, canShare, busy, copied, copy, shares }: SharePanelProps) {
  const {
    contacts,
    contactsLoading,
    contactsError,
    refreshContacts,
    shareRecipients,
    toggleRecipient,
    shareQuery,
    setShareQuery,
    manualRecipient,
    setManualRecipient,
    addManualRecipient,
    shareDays,
    setShareDays,
    shareLabel,
    setShareLabel,
    shareResults,
    shareFailures,
    filteredContacts,
    createShare
  } = shares

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 p-3">
      <p className="text-ui-10 text-[color:var(--color-muted)]">
        Only this identity can decrypt the endpoint. The recipient can still reach it until
        the share expires; rotate the endpoint to cut access.
      </p>
      {!canShare ? (
        <p className="rounded border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-2 py-1 text-ui-10 text-[color:var(--color-muted)]">
          {service.endpoints.length === 0
            ? 'This service has no endpoints yet. Add one with Edit before creating links.'
            : 'This service only has a loopback endpoint. Add a LAN, public or .onion endpoint with Edit before creating links.'}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="text-ui-10 font-medium text-[color:var(--color-text)]">Recipients from your contact list</p>
        <button
          type="button"
          onClick={() => void refreshContacts()}
          disabled={contactsLoading}
          className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', contactsLoading && 'animate-spin')} />
          {contactsLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <input
        value={shareQuery}
        onChange={(event) => setShareQuery(event.target.value)}
        placeholder="Search contacts by name, NIP-05 or npub"
        className="w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
      />

      <div className="max-h-40 overflow-y-auto rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/40">
        {filteredContacts.length === 0 ? (
          <p className="px-2.5 py-3 text-ui-10 text-[color:var(--color-faint)]">
            {contacts ? 'No contacts match.' : 'No contact list cached yet. Refresh, or add an npub below.'}
          </p>
        ) : null}
        {filteredContacts.slice(0, 80).map((contact: ContactProfile) => {
          const selected = shareRecipients.includes(contact.pubkey)
          return (
            <label
              key={contact.pubkey}
              data-contact={contact.pubkey}
              className={cn(
                'flex cursor-pointer items-center gap-2 border-b border-[color:var(--color-line)]/60 px-2.5 py-1.5 text-ui-11 last:border-0',
                selected
                  ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-text)]'
                  : 'text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]'
              )}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => toggleRecipient(contact.pubkey)}
                className="h-3.5 w-3.5 accent-[color:var(--color-accent)]"
              />
              <span className="min-w-0 flex-1 truncate">{contactLabel(contact)}</span>
              <span className="shrink-0 font-mono text-ui-95 text-[color:var(--color-faint)]">
                {contact.nip05 || shortIdentity(recipientNpub(contact.pubkey))}
              </span>
            </label>
          )
        })}
      </div>

      {contacts?.stale ? (
        <p className="text-ui-10 text-[color:var(--color-faint)]">
          This contact list is cached. Refresh to check for follow-list changes.
        </p>
      ) : null}
      {contactsError ? (
        <p className="text-ui-10 text-[color:var(--color-danger)]">{contactsError}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <input
          value={manualRecipient}
          onChange={(event) => setManualRecipient(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addManualRecipient()
            }
          }}
          placeholder="npub1… not in contacts"
          className="min-w-0 flex-1 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
        />
        <button
          type="button"
          onClick={addManualRecipient}
          className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
        >
          Add
        </button>
        <select
          value={shareDays}
          onChange={(event) => setShareDays(event.target.value)}
          className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2 py-1.5 text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
        >
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
        </select>
      </div>

      {shareRecipients.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {shareRecipients.map((recipient) => {
            const contact = contacts?.contacts.find((entry) => entry.pubkey === recipient)
            return (
              <span
                key={recipient}
                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-2 py-0.5 text-ui-10 text-[color:var(--color-text)]"
              >
                <span className="max-w-[160px] truncate">
                  {contact ? contactLabel(contact) : shortIdentity(recipientNpub(recipient))}
                </span>
                <button
                  type="button"
                  onClick={() => toggleRecipient(recipient)}
                  aria-label="Remove recipient"
                  className="text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
        </div>
      ) : null}

      <div className="flex gap-2">
        <input
          value={shareLabel}
          onChange={(event) => setShareLabel(event.target.value)}
          placeholder="Label (optional, local only)"
          className="flex-1 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => void createShare(service)}
          disabled={busy || !canShare || shareRecipients.length === 0}
          className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
        >
          {shareRecipients.length > 1
            ? `Create ${shareRecipients.length} links`
            : 'Create link'}
        </button>
      </div>

      {shareResults.length > 0 ? (
        <div className="space-y-1">
          {shareResults.map((link) => (
            <button
              key={`${link.recipient}:${link.address}`}
              data-share-result
              type="button"
              onClick={() => void copy(`share-result:${link.address}`, link.address)}
              className="flex w-full items-center gap-2 rounded-lg border border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok)]/10 px-2.5 py-2 text-left font-mono text-ui-10 text-[color:var(--color-text)]"
            >
              <Link2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{link.address}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-[color:var(--color-ok)]">
                {copied === `share-result:${link.address}` ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {shareFailures.length > 0 ? (
        <ul className="space-y-0.5 rounded-lg bg-[color:var(--color-danger)]/10 px-2.5 py-2 text-ui-10 text-[color:var(--color-danger)]">
          {shareFailures.map((failure) => (
            <li key={failure.recipient}>
              {shortIdentity(recipientNpub(failure.recipient))}: {failure.error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
