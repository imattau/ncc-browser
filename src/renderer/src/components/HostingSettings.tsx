import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Share2,
  Trash2,
  X
} from 'lucide-react'
import { nip19 } from 'nostr-tools'
import {
  DEFAULT_HOSTED_TTL_SECONDS,
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  MIN_SHARE_DAYS,
  serviceAddress,
  recipientNpub,
  parseRecipient,
  shareStatus,
  type HostedService,
  type HostingDraft,
  type HostingState,
  type HostingVisibility,
  type ServiceShare
} from '@shared/hosting'
import { contactLabel, type ContactList, type ContactProfile } from '@shared/contacts'
import type { IdentityStatus } from '@shared/types'
import { cn } from '../lib/cn'

interface HostingSettingsProps {
  identity: IdentityStatus | null
  initialDraft?: HostingDraft | null
  onDraftUsed?: () => void
  onOpenIdentity: () => void
  onClose: () => void
}

interface DraftState {
  id?: string
  title: string
  service: string
  endpoints: string
  ttlDays: string
  visibility: HostingVisibility
  anchor: boolean
  notes: string
}

const EMPTY_DRAFT: DraftState = {
  title: '',
  service: '',
  endpoints: '',
  ttlDays: String(DEFAULT_HOSTED_TTL_SECONDS / 86_400),
  visibility: 'private',
  anchor: true,
  notes: ''
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}

function relative(seconds: number | undefined): string {
  if (!seconds) return 'not published'
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`
  if (delta < 86_400) return `${Math.floor(delta / 3600)} h ago`
  return `${Math.floor(delta / 86_400)} d ago`
}

function until(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min left`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h left`
  return `${Math.round(seconds / 86_400)} d left`
}

function shortIdentity(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value
}

export function HostingSettings({ identity, initialDraft, onDraftUsed, onOpenIdentity, onClose }: HostingSettingsProps) {
  const [state, setState] = useState<HostingState | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [busy, setBusy] = useState(false)
  const [strictAnchors, setStrictAnchors] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [contacts, setContacts] = useState<ContactList | null>(null)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [shareRecipients, setShareRecipients] = useState<string[]>([])
  const [shareQuery, setShareQuery] = useState('')
  const [manualRecipient, setManualRecipient] = useState('')
  const [shareDays, setShareDays] = useState(String(DEFAULT_SHARE_DAYS))
  const [shareLabel, setShareLabel] = useState('')
  const [shareResults, setShareResults] = useState<Array<{ recipient: string; address: string }>>([])
  const [shareFailures, setShareFailures] = useState<Array<{ recipient: string; error: string }>>([])

  const apply = useCallback((next: HostingState) => setState(next), [])

  useEffect(() => {
    let alive = true
    void window.ncc.getConfig().then((config) => {
      if (alive) setStrictAnchors(config.anchorRequired)
    })
    void window.ncc.contactsState().then((state) => {
      if (!alive) return
      setContacts(state.list)
      setContactsLoading(state.refreshing)
      setContactsError(state.error ?? null)
    }).catch(() => undefined)
    const offContacts = window.ncc.onContactsChanged((state) => {
      if (!alive) return
      setContacts(state.list)
      setContactsLoading(state.refreshing)
      setContactsError(state.error ?? null)
    })
    void window.ncc.hostingState().then((next) => alive && apply(next))
    const off = window.ncc.onHostingChanged((next) => alive && apply(next))
    return () => {
      alive = false
      off()
      offContacts()
    }
  }, [apply])

  useEffect(() => {
    if (!initialDraft) return
    setDraft({
      ...EMPTY_DRAFT,
      title: initialDraft.title,
      service: initialDraft.service ?? '',
      endpoints: initialDraft.endpoints
        .map((endpoint) => (typeof endpoint === 'string' ? endpoint : endpoint.url))
        .join('\n'),
      ttlDays: String(
        Math.max(1, Math.round((initialDraft.ttlSeconds ?? DEFAULT_HOSTED_TTL_SECONDS) / 86_400))
      ),
      visibility: initialDraft.visibility ?? 'private',
      anchor: initialDraft.anchor === true,
      notes: initialDraft.notes ?? ''
    })
    onDraftUsed?.()
  }, [initialDraft, onDraftUsed])

  const npub = useMemo(() => {
    if (identity?.npub) return identity.npub
    if (identity?.hexPubkey) {
      try {
        return nip19.npubEncode(identity.hexPubkey)
      } catch {
        return ''
      }
    }
    return ''
  }, [identity])

  const services = state?.services ?? []
  const shares = state?.shares ?? []

  const copy = async (id: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      setError('Could not copy to the clipboard')
    }
  }

  const startCreate = (): void => {
    setDraft({ ...EMPTY_DRAFT })
    setError(null)
    setShareResults([])
    setShareFailures([])
  }

  const startEdit = (service: HostedService): void => {
    setDraft({
      id: service.id,
      title: service.title,
      service: service.service,
      endpoints: service.endpoints.map((endpoint) => endpoint.url).join('\n'),
      ttlDays: String(Math.max(1, Math.round(service.ttlSeconds / 86_400))),
      visibility: service.visibility,
      anchor: service.anchor,
      notes: service.notes ?? ''
    })
    setError(null)
    setShareResults([])
    setShareFailures([])
  }

  const submit = async (): Promise<void> => {
    if (!draft) return
    const endpoints = draft.endpoints
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (!draft.title.trim()) return setError('Give the service a name')
    if (endpoints.length === 0) return setError('Add at least one endpoint')
    setBusy(true)
    setError(null)
    try {
      const payload = {
        title: draft.title,
        ...(draft.id ? {} : draft.service.trim() ? { service: draft.service } : {}),
        endpoints,
        ttlSeconds: Math.max(1, Number(draft.ttlDays) || 7) * 86_400,
        visibility: draft.visibility,
        anchor: strictAnchors ? true : draft.anchor,
        notes: draft.notes
      }
      const next = draft.id
        ? await window.ncc.hostingUpdate(draft.id, payload)
        : await window.ncc.hostingCreate(payload)
      apply(next)
      setDraft(null)
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setBusy(false)
    }
  }

  const publish = async (service: HostedService): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingPublish(service.id)
      if (!result.ok) setError(`Published to ${result.accepted} of ${result.relays} relays`)
      apply(await window.ncc.hostingState())
    } catch (publishError) {
      setError(errorMessage(publishError))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (service: HostedService): Promise<void> => {
    if (!window.confirm(`Remove "${service.title}" and its shares from this browser?`)) return
    setBusy(true)
    try {
      apply(await window.ncc.hostingRemove(service.id))
      if (draft?.id === service.id) setDraft(null)
    } catch (removeError) {
      setError(errorMessage(removeError))
    } finally {
      setBusy(false)
    }
  }

  const refreshContacts = async (): Promise<void> => {
    setContactsLoading(true)
    try {
      const state = await window.ncc.contactsRefresh()
      setContacts(state.list)
      setContactsError(state.error ?? null)
    } catch (error) {
      setContactsError(errorMessage(error))
    } finally {
      setContactsLoading(false)
    }
  }

  const toggleRecipient = (pubkey: string): void => {
    setShareRecipients((current) =>
      current.includes(pubkey) ? current.filter((value) => value !== pubkey) : [...current, pubkey]
    )
  }

  const addManualRecipient = (): void => {
    const recipient = parseRecipient(manualRecipient)
    if (!recipient) {
      setError('Enter a valid npub or 64-character public key')
      return
    }
    setShareRecipients((current) => (current.includes(recipient) ? current : [...current, recipient]))
    setManualRecipient('')
  }

  const filteredContacts = useMemo(() => {
    const query = shareQuery.trim().toLowerCase()
    const list = [...(contacts?.contacts ?? [])].sort((a, b) => contactLabel(a).localeCompare(contactLabel(b)))
    if (!query) return list
    return list.filter((contact) =>
      [contact.displayName, contact.name, contact.nip05, contact.pubkey].some((value) =>
        value?.toLowerCase().includes(query)
      )
    )
  }, [contacts, shareQuery])

  const createShare = async (service: HostedService): Promise<void> => {
    if (shareRecipients.length === 0) {
      setError('Choose at least one recipient')
      return
    }
    setBusy(true)
    setError(null)
    setShareResults([])
    setShareFailures([])
    try {
      const result = await window.ncc.hostingShareMany(
        service.id,
        shareRecipients,
        Math.min(MAX_SHARE_DAYS, Math.max(MIN_SHARE_DAYS, Number(shareDays) || DEFAULT_SHARE_DAYS)),
        shareLabel
      )
      setShareResults(result.shares.map((entry) => ({ recipient: entry.recipient, address: entry.address })))
      setShareFailures(result.failures)
      if (result.shares.length > 0) {
        setShareRecipients([])
        setShareLabel('')
      }
      apply(await window.ncc.hostingState())
    } catch (shareError) {
      setError(errorMessage(shareError))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (share: ServiceShare): Promise<void> => {
    if (!window.confirm('Revoke this share? The recipient may still have the endpoint until it rotates.')) return
    setBusy(true)
    try {
      await window.ncc.hostingRevokeShare(share.id)
      apply(await window.ncc.hostingState())
    } catch (revokeError) {
      setError(errorMessage(revokeError))
    } finally {
      setBusy(false)
    }
  }

  const renewShare = async (service: HostedService, share: ServiceShare): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingShare(
        service.id,
        share.recipient,
        DEFAULT_SHARE_DAYS,
        share.label
      )
      setShareResults([{ recipient: share.recipient, address: result.address }])
      setShareFailures([])
      apply(await window.ncc.hostingState())
    } catch (renewError) {
      setError(errorMessage(renewError))
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  return (
    <div className="space-y-5" data-hosting-settings>
      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">Hosted services</h2>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Give a service you run an identity address. Publish it as{' '}
          <span className="font-mono text-[color:var(--color-text)]">ncc://&lt;your npub&gt;/&lt;service&gt;</span>{' '}
          and share it with one person&apos;s npub. Private locators are encrypted, so relays carry the
          hint but not the endpoint.
        </p>
      </div>

      {!identity?.configured ? (
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-12 text-[color:var(--color-muted)]">
          Hosting needs an identity to sign the locator.{' '}
          <button
            type="button"
            onClick={onOpenIdentity}
            className="text-[color:var(--color-accent)] underline-offset-2 hover:underline"
          >
            Set up an identity
          </button>
        </div>
      ) : null}

      <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Your services</h3>
            <p className="text-ui-105 text-[color:var(--color-muted)]">
              {services.length ? `${services.length} published or ready to publish` : 'Nothing published yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={startCreate}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add service
          </button>
        </div>

        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-danger)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        ) : null}

        {draft ? (
          <form
            className="space-y-3 rounded-xl border border-[color:var(--color-accent)]/30 bg-[color:var(--color-field)] p-3.5"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Name
                <input
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  placeholder="Photos"
                  className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
                />
              </label>
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Service id
                <input
                  value={draft.service}
                  disabled={Boolean(draft.id)}
                  onChange={(event) => setDraft({ ...draft, service: event.target.value })}
                  placeholder="photos"
                  className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)] disabled:opacity-60"
                />
              </label>
            </div>

            <label className="block text-ui-105 text-[color:var(--color-muted)]">
              Endpoints, one per line
              <textarea
                value={draft.endpoints}
                onChange={(event) => setDraft({ ...draft, endpoints: event.target.value })}
                rows={2}
                placeholder={'https://photos.example\nhttp://abc.onion'}
                className="mt-1 w-full resize-y rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 font-mono text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-ui-105 text-[color:var(--color-muted)]">
                Visibility
                <select
                  value={draft.visibility}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
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
                  onChange={(event) => setDraft({ ...draft, ttlDays: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
                />
              </label>
            </div>

            <label className="flex items-start gap-2 text-ui-11 text-[color:var(--color-muted)]">
              <input
                type="checkbox"
                checked={draft.anchor || strictAnchors}
                disabled={strictAnchors}
                onChange={(event) => setDraft({ ...draft, anchor: event.target.checked })}
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
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                maxLength={280}
                className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
              />
            </label>

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
                onClick={() => setDraft(null)}
                className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {services.length === 0 && !draft ? (
          <div className="rounded-xl border border-dashed border-[color:var(--color-line)] px-4 py-6 text-center text-ui-12 text-[color:var(--color-muted)]">
            <Server className="mx-auto mb-2 h-5 w-5 text-[color:var(--color-faint)]" />
            Publish a service running on this machine or a home server. The browser holds the identity;
            the locator points at your endpoint.
          </div>
        ) : null}

        {services.map((service) => {
          const serviceNpub = service.owner ? recipientNpub(service.owner) : npub
          const address = serviceNpub ? serviceAddress(serviceNpub, service.service) : ''
          const serviceShares = shares.filter((share) => share.serviceId === service.id)
          const expired = Boolean(
            service.lastPublishedAt && service.lastPublishedAt + service.ttlSeconds <= Math.floor(Date.now() / 1000)
          )
          return (
            <div
              key={service.id}
              data-hosting-service={service.service}
              className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                      {service.title}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ui-95',
                        service.lastPublishError
                          ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
                          : service.lastPublishedAt && !expired
                            ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                            : 'bg-[color:var(--color-hover)] text-[color:var(--color-muted)]'
                      )}
                    >
                      {service.lastPublishError
                        ? 'publish failed'
                        : expired
                          ? 'expired'
                          : service.lastPublishedAt
                            ? `published ${relative(service.lastPublishedAt)}`
                            : 'not published'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-ui-95 text-[color:var(--color-faint)]">
                      {service.visibility === 'private' ? (
                        <>
                          <Lock className="h-3 w-3" /> private
                        </>
                      ) : (
                        <>
                          <Globe className="h-3 w-3" /> public
                        </>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copy(`address:${service.id}`, address)}
                    title="Copy address"
                    className="mt-1 block max-w-full truncate font-mono text-ui-105 text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
                  >
                    {copied === `address:${service.id}` ? 'copied' : address || 'connect an identity'}
                  </button>
                  {service.owner && npub && serviceNpub !== npub ? (
                    <p className="mt-1 text-ui-10 text-[color:var(--color-danger)]">
                      Published as a different identity. Switch back to publish or share it.
                    </p>
                  ) : null}
                  <div className="mt-1 space-y-0.5">
                    {service.endpoints.map((endpoint) => (
                      <div key={endpoint.url} className="truncate font-mono text-ui-95 text-[color:var(--color-faint)]">
                        {endpoint.url}
                      </div>
                    ))}
                  </div>
                  {service.lastPublishError ? (
                    <p className="mt-1 text-ui-10 text-[color:var(--color-danger)]">{service.lastPublishError}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void window.ncc.navigate(address)
                      onClose()
                    }}
                    disabled={!address}
                    className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
                  >
                    <ExternalLink className="h-3 w-3" /> Open
                  </button>
                  <button
                    type="button"
                    onClick={() => void publish(service)}
                    disabled={busy || !identity?.configured}
                    className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
                  >
                    <RefreshCw className="h-3 w-3" /> Publish
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(service)}
                    className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSharing(sharing === service.id ? null : service.id)
                      setShareResults([])
    setShareFailures([])
                    }}
                    disabled={service.visibility !== 'private'}
                    className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
                  >
                    <Share2 className="h-3 w-3" /> Share
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(service)}
                    title="Remove service"
                    aria-label={`Remove ${service.title}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-10 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>

              {sharing === service.id ? (
                <div className="mt-3 space-y-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 p-3">
                  <p className="text-ui-10 text-[color:var(--color-muted)]">
                    Only this identity can decrypt the endpoint. The recipient can still reach it until
                    the share expires; rotate the endpoint to cut access.
                  </p>
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
                    {filteredContacts.slice(0, 80).map((contact) => {
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
                      disabled={busy || shareRecipients.length === 0}
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
              ) : null}

              {serviceShares.length > 0 ? (
                <div className="mt-3 space-y-1.5 border-t border-[color:var(--color-line)] pt-2">
                  {serviceShares.map((share) => {
                    const status = shareStatus(share, Math.floor(Date.now() / 1000))
                    return (
                      <div key={share.id} className="flex flex-wrap items-center gap-2 text-ui-10">
                        <span className="min-w-0 flex-1 truncate text-[color:var(--color-muted)]">
                          {share.label || shortIdentity(share.recipientNpub || share.recipient)}
                          <span className="ml-2 text-[color:var(--color-faint)]">
                            {status === 'active' ? until(share.expiresAt) : status}
                          </span>
                        </span>
                        {status === 'active' ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void copy(`share:${share.id}`, serviceAddress(serviceNpub, share.dTag))}
                              className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                            >
                              {copied === `share:${share.id}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                              Copy
                            </button>
                            <button
                              type="button"
                              onClick={() => void revoke(share)}
                              disabled={busy}
                              className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                            >
                              Revoke
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void renewShare(service, share)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                          >
                            <RefreshCw className="h-3 w-3" /> Renew
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : null}

              {service.visibility === 'public' && serviceShares.length > 0 ? (
                <p className="mt-2 text-ui-10 text-[color:var(--color-muted)]">
                  This service is public, so anyone with the address can already open it. Existing
                  share links stay valid until they expire.
                </p>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div>
          <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Shared with me</h3>
          <p className="text-ui-105 text-[color:var(--color-muted)]">
            Services another identity encrypted to you. Opening one needs the identity it was shared with.
          </p>
        </div>
        {state.received.length === 0 ? (
          <p className="text-ui-11 text-[color:var(--color-faint)]">Nothing received yet.</p>
        ) : (
          <div className="space-y-1.5">
            {state.received.map((share) => {
              const expired = share.expiresAt <= Math.floor(Date.now() / 1000)
              return (
                <div
                  key={share.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-[color:var(--color-field)] px-2.5 py-2 text-ui-11"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[color:var(--color-text)]">
                      {share.title || `Shared service ${share.dTag.slice(0, 18)}`}
                    </div>
                    <div className="truncate text-ui-95 text-[color:var(--color-faint)]">
                      from {shortIdentity(share.ownerNpub || share.owner)} · {until(share.expiresAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void window.ncc.navigate(serviceAddress(share.ownerNpub || share.owner, share.dTag))
                      onClose()
                    }}
                    disabled={expired}
                    className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
                  >
                    <ExternalLink className="h-3 w-3" /> Open
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.ncc.hostingForgetReceived(share.id).then(apply)}
                    className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p className="flex items-start gap-2 text-ui-10 leading-relaxed text-[color:var(--color-faint)]">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        A locator is a signed hint, not a tunnel. The endpoint must be reachable directly or through Tor.
        The browser renews locators while it runs; close it for longer than the lifetime and the address
        stops resolving until you publish again.
      </p>
    </div>
  )
}
