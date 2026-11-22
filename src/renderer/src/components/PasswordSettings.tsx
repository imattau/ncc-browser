import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unlock,
  Upload,
  Vault,
  Wand2,
  X
} from 'lucide-react'
import type { IdentityStatus } from '@shared/types'
import type {
  PasswordDraft,
  PasswordEntry,
  PasswordHealthEntry,
  PasswordHealthReport,
  PasswordImportPreview,
  PasswordSummary,
  PasswordTotpCode,
  PasswordVaultStatus
} from '@shared/passwords'
import { scorePassword } from '@shared/password-strength'
import { cn } from '../lib/cn'
import { messageOf } from '../lib/format'
import { PaymentCardsSettings } from './PaymentCardsSettings'

interface PasswordSettingsProps {
  identity: IdentityStatus | null
  draftOrigin?: string | null
  onDraftUsed?: () => void
  onOpenIdentity: () => void
}

const AUTO_LOCK_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' }
]

const ROTATION_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' }
]

export function PasswordSettings({
  identity,
  draftOrigin,
  onDraftUsed,
  onOpenIdentity
}: PasswordSettingsProps) {
  const [status, setStatus] = useState<PasswordVaultStatus | null>(null)
  const [entries, setEntries] = useState<PasswordSummary[]>([])
  const [health, setHealth] = useState<PasswordHealthReport | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<PasswordEntry | null>(null)
  const [draft, setDraft] = useState<PasswordDraft>(emptyDraft())
  const [revealPassword, setRevealPassword] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [revealed, setRevealed] = useState<{ id: string; password: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const [relayDraft, setRelayDraft] = useState('')
  const [importPreview, setImportPreview] = useState<PasswordImportPreview | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'skip' | 'add'>('merge')
  const [exportArmed, setExportArmed] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.ncc.passwordsStatus()
    setStatus(next)
    if (next.unlocked) {
      setEntries(await window.ncc.passwordsList())
      setHealth(await window.ncc.passwordsHealth())
    } else {
      setEntries([])
      setHealth(null)
    }
    setRelayDraft((current) => current || next.vaultRelay)
  }, [])

  useEffect(() => {
    void refresh().catch((loadError) => setError(messageOf(loadError)))
    return window.ncc.onPasswordStatus((next) => {
      setStatus(next)
      if (!next.unlocked) {
        setEntries([])
        setHealth(null)
      }
    })
  }, [refresh])

  useEffect(() => {
    if (status?.unlocked) {
      void window.ncc.passwordsList().then(setEntries).catch(() => undefined)
      void window.ncc.passwordsHealth().then(setHealth).catch(() => undefined)
    }
  }, [status?.unlocked, status?.lastSyncedAt, status?.rotationDays])

  useEffect(() => {
    if (!draftOrigin) return
    setEditing(null)
    setShowForm(true)
    setDraft(emptyDraft(draftOrigin))
    setFormError(null)
    onDraftUsed?.()
  }, [draftOrigin, onDraftUsed])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((entry) =>
      `${entry.title} ${entry.origin} ${entry.username}`.toLowerCase().includes(needle)
    )
  }, [entries, search])

  const unlock = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.ncc.passwordsUnlock()
      setStatus(next)
      if (next.error) setError(next.error)
      setEntries(await window.ncc.passwordsList())
    } catch (unlockError) {
      setError(messageOf(unlockError))
    } finally {
      setBusy(false)
    }
  }

  const lock = async (): Promise<void> => {
    setStatus(await window.ncc.passwordsLock())
    setEntries([])
    setHealth(null)
    setRevealed(null)
    setShowForm(false)
    setEditing(null)
  }

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setError(null)
    try {
      const next = await window.ncc.passwordsSync()
      setStatus(next)
      if (next.error) setError(next.error)
      setEntries(await window.ncc.passwordsList())
    } finally {
      setSyncing(false)
    }
  }

  const startAdd = (): void => {
    setEditing(null)
    setDraft(emptyDraft())
    setFormError(null)
    setRevealPassword(false)
    setShowForm(true)
  }

  const startEdit = async (id: string): Promise<void> => {
    setError(null)
    try {
      const entry = await window.ncc.passwordsEntry(id)
      if (!entry) return
      setEditing(entry)
      setDraft({
        id: entry.id,
        origin: entry.origin,
        title: entry.title,
        username: entry.username,
        password: entry.password,
        notes: entry.notes,
        totp: entry.totp
      })
      setFormError(null)
      setRevealPassword(false)
      setShowForm(true)
    } catch (editError) {
      setError(messageOf(editError))
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    try {
      const result = await window.ncc.passwordsSave(draft)
      if (!result.ok) {
        setFormError(result.error ?? 'Could not save the login')
        return
      }
      setShowForm(false)
      setEditing(null)
      setNotice(result.pending ? 'Saved locally; relay sync will retry.' : 'Login saved.')
      if (result.status) setStatus(result.status)
      setEntries(await window.ncc.passwordsList())
      setHealth(await window.ncc.passwordsHealth())
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    setConfirmDelete(null)
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.passwordsRemove(id)
      if (!result.ok) {
        setError(result.error ?? 'Could not delete the login')
        return
      }
      setEntries(await window.ncc.passwordsList())
      setHealth(await window.ncc.passwordsHealth())
      setRevealed((current) => (current?.id === id ? null : current))
      setNotice('Login deleted.')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (id: string, field: 'username' | 'password' | 'totp'): Promise<void> => {
    setError(null)
    const result = await window.ncc.passwordsCopy(id, field)
    if (!result.ok) {
      setError(result.error ?? 'Could not copy')
      return
    }
    setNotice(
      result.clearsAt
        ? 'Copied. The clipboard clears in 30 seconds.'
        : 'Username copied.'
    )
  }

  const reveal = async (id: string): Promise<void> => {
    if (revealed?.id === id) {
      setRevealed(null)
      return
    }
    try {
      const password = await window.ncc.passwordsReveal(id)
      setRevealed({ id, password })
      window.setTimeout(() => {
        setRevealed((current) => (current?.id === id ? null : current))
      }, 15_000)
    } catch (revealError) {
      setError(messageOf(revealError))
    }
  }

  const generate = async (): Promise<void> => {
    try {
      const password = await window.ncc.passwordsGenerate({
        length: 20,
        symbols: true,
        avoidAmbiguous: false
      })
      setDraft((current) => ({ ...current, password }))
      setRevealPassword(true)
    } catch (generateError) {
      setFormError(messageOf(generateError))
    }
  }

  const updateConfig = async (patch: Parameters<typeof window.ncc.passwordsSetConfig>[0]): Promise<void> => {
    setError(null)
    try {
      setStatus(await window.ncc.passwordsSetConfig(patch))
    } catch (configError) {
      setError(messageOf(configError))
    }
  }

  const importOpen = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const preview = await window.ncc.passwordsImportOpen()
      if (preview.cancelled) return
      if (preview.error && preview.count === 0) {
        setError(preview.error)
        return
      }
      setImportPreview(preview)
      setImportMode('merge')
    } finally {
      setBusy(false)
    }
  }

  const importCommit = async (): Promise<void> => {
    if (!importPreview) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.passwordsImportCommit(importPreview.id, importMode)
      if (!result.ok) {
        setError(result.error ?? 'Could not import')
        return
      }
      setImportPreview(null)
      setNotice('Passwords imported.')
      if (result.status) setStatus(result.status)
      setEntries(await window.ncc.passwordsList())
      setHealth(await window.ncc.passwordsHealth())
    } finally {
      setBusy(false)
    }
  }

  const exportVault = async (format: 'encrypted' | 'csv'): Promise<void> => {
    if (format === 'csv' && !exportArmed) {
      setExportArmed(true)
      return
    }
    setExportArmed(false)
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.passwordsExport(format)
      if (!result.ok) {
        if (result.error !== 'Export cancelled') setError(result.error ?? 'Could not export')
        return
      }
      setNotice(`Exported to ${result.path}`)
    } finally {
      setBusy(false)
    }
  }

  if (!identity?.configured) {
    return (
      <>
        <Heading />
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] px-4 py-10 text-center">
          <LockKeyhole className="mx-auto h-6 w-6 text-[color:var(--color-faint-dim)]" />
          <p className="mt-3 text-ui-13 font-semibold text-[color:var(--color-text-strong)]">
            An identity is required
          </p>
          <p className="mx-auto mt-1 max-w-md text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
            The vault is encrypted to your own Nostr identity. Import or generate a key, then
            return here to unlock it.
          </p>
          <button
            type="button"
            onClick={onOpenIdentity}
            className="mt-4 rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]"
          >
            Open Identity & signer
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <Heading />

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-lg',
                status?.unlocked
                  ? 'bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
                  : 'bg-[color:var(--color-field)] text-[color:var(--color-muted)]'
              )}
            >
              {status?.unlocked ? (
                <Unlock className="h-4 w-4" />
              ) : (
                <LockKeyhole className="h-4 w-4" />
              )}
            </span>
            <div>
              <p className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                {status?.unlocked ? 'Vault unlocked' : 'Vault locked'}
              </p>
              <p className="text-ui-105 text-[color:var(--color-muted)]">
                {status?.unlocked
                  ? `${status.entryCount} login${status.entryCount === 1 ? '' : 's'} · ${status.syncing ? 'syncing…' : status.lastSyncedAt ? `synced ${timeAgo(status.lastSyncedAt)}` : 'not synced yet'}`
                  : 'Unlock with your Nostr identity to view logins.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status?.unlocked ? (
              <>
                <button
                  type="button"
                  data-password-sync
                  disabled={syncing}
                  onClick={() => void sync()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
                  Sync now
                </button>
                <button
                  type="button"
                  onClick={() => void lock()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
                >
                  <LockKeyhole className="h-3.5 w-3.5" />
                  Lock
                </button>
              </>
            ) : (
              <button
                type="button"
                data-password-unlock
                disabled={busy}
                onClick={() => void unlock()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50"
              >
                <Unlock className="h-3.5 w-3.5" />
                {busy ? 'Unlocking…' : 'Unlock vault'}
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-105 text-[color:var(--color-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
            {identity.mode === 'nip46' ? 'Remote NIP-46 identity' : 'Local identity'}
          </span>
          <span className="min-w-0 truncate">
            {status?.relaySource === 'dedicated' ? 'Dedicated relay' : `via ${status?.relaySource ?? 'browser'} relays`}:{' '}
            <span className="font-mono">{status?.relays.join(' · ') || 'none'}</span>
          </span>
          {status?.pending ? (
            <span className="text-[color:var(--color-warn)]">pending relay sync</span>
          ) : null}
        </div>

        {status?.error ? (
          <p className="mt-3 rounded-lg border border-[color:var(--color-danger)]/25 bg-[color:var(--color-danger)]/10 px-2.5 py-2 text-ui-11 text-[color:var(--color-danger)]">
            {status.error}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-lg border border-[color:var(--color-danger)]/25 bg-[color:var(--color-danger)]/10 px-2.5 py-2 text-ui-11 text-[color:var(--color-danger)]">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-3 text-ui-11 text-[color:var(--color-ok)]">{notice}</p>
        ) : null}
      </div>

      {status?.unlocked ? (
        <>
          <PasswordHealthPanel health={health} onEdit={(id) => void startEdit(id)} />

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-faint)]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, origin or username"
                aria-label="Search passwords"
                className="w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] py-1.5 pl-8 pr-3 text-ui-11 text-[color:var(--color-text)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]/60"
              />
            </div>
            <button
              type="button"
              data-password-add-button
              onClick={startAdd}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add login
            </button>
          </div>

          {showForm ? (
            <PasswordForm
              draft={draft}
              editing={Boolean(editing)}
              reveal={revealPassword}
              busy={busy}
              error={formError}
              onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
              onToggleReveal={() => setRevealPassword((current) => !current)}
              onGenerate={() => void generate()}
              onCancel={() => {
                setShowForm(false)
                setEditing(null)
                setFormError(null)
              }}
              onSave={() => void save()}
            />
          ) : null}

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] px-4 py-10 text-center">
              <Vault className="mx-auto h-6 w-6 text-[color:var(--color-faint-dim)]" />
              <p className="mt-2 text-ui-12 text-[color:var(--color-muted)]">
                {entries.length === 0 ? 'No logins saved yet.' : 'No logins match that search.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2" data-password-list>
              {filtered.map((entry) => (
                <li
                  key={entry.id}
                  data-password-entry={entry.id}
                  className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-3"
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                        {entry.title || entry.origin}
                      </p>
                      <p className="truncate font-mono text-ui-105 text-[color:var(--color-muted)]">
                        {entry.origin}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 truncate text-ui-105 text-[color:var(--color-faint)]">
                        <KeyRound className="h-3 w-3" />
                        {entry.isPasskey ? 'Passkey' : entry.username || 'No username'}
                        {entry.hasTotp ? (
                          <span className="ml-1 rounded border border-[color:var(--color-accent)]/30 px-1 text-ui-9 text-[color:var(--color-accent)]">
                            2FA
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {entry.hasTotp ? <TotpCell id={entry.id} onCopy={copy} /> : null}
                      {!entry.isPasskey ? <>
                        <RowButton label="Copy username" onClick={() => void copy(entry.id, 'username')}><Copy className="h-3.5 w-3.5" /></RowButton>
                        <RowButton label="Copy password" onClick={() => void copy(entry.id, 'password')}><KeyRound className="h-3.5 w-3.5" /></RowButton>
                        <RowButton label={revealed?.id === entry.id ? 'Hide password' : 'Reveal password'} onClick={() => void reveal(entry.id)}>
                          {revealed?.id === entry.id ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </RowButton>
                        <RowButton label="Edit login" onClick={() => void startEdit(entry.id)}><Pencil className="h-3.5 w-3.5" /></RowButton>
                      </> : null}
                      <button
                        type="button"
                        aria-label={confirmDelete === entry.id ? 'Confirm delete' : 'Delete login'}
                        title={confirmDelete === entry.id ? 'Click again to delete' : 'Delete login'}
                        onClick={() => void remove(entry.id)}
                        className={cn(
                          'shrink-0 rounded-lg px-2 py-1.5 text-ui-10',
                          confirmDelete === entry.id
                            ? 'bg-[color:var(--color-danger)] text-[color:var(--color-on-danger)]'
                            : 'text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]'
                        )}
                      >
                        {confirmDelete === entry.id ? 'Delete?' : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                  {revealed?.id === entry.id ? (
                    <code className="mt-2 block break-all rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5 font-mono text-ui-11 text-[color:var(--color-text)]">
                      {revealed.password}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
              Sync and unlock
            </h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-ui-11 text-[color:var(--color-muted)]">
                Auto-lock
                <select
                  value={status?.autoLockMinutes ?? 15}
                  onChange={(event) =>
                    void updateConfig({ autoLockMinutes: Number(event.target.value) })
                  }
                  className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)]"
                >
                  {AUTO_LOCK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-ui-11 text-[color:var(--color-muted)]">
                Flag passwords as stale after
                <select
                  value={status?.rotationDays ?? 365}
                  onChange={(event) =>
                    void updateConfig({ rotationDays: Number(event.target.value) })
                  }
                  className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)]"
                >
                  {ROTATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-ui-11 text-[color:var(--color-muted)]">
                Dedicated vault relay
                <div className="flex gap-1.5">
                  <input
                    value={relayDraft}
                    onChange={(event) => setRelayDraft(event.target.value)}
                    placeholder="wss://private-relay.example"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5 font-mono text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
                  />
                  <button
                    type="button"
                    onClick={() => void updateConfig({ vaultRelay: relayDraft })}
                    className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                  >
                    Save
                  </button>
                </div>
              </label>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-ui-11 text-[color:var(--color-muted)]">
              <input
                type="checkbox"
                checked={status?.offerSave ?? true}
                onChange={(event) => void updateConfig({ offerSave: event.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]"
              />
              Offer to save logins after a form submit
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-ui-11 text-[color:var(--color-muted)]">
              <input
                type="checkbox"
                checked={status?.useNip65 ?? true}
                disabled={Boolean(status?.vaultRelay)}
                onChange={(event) => void updateConfig({ useNip65: event.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]"
              />
              Also use my NIP-65 write relays
            </label>

            {(status?.neverSave.length ?? 0) > 0 ? (
              <div className="mt-3">
                <p className="text-ui-105 font-medium text-[color:var(--color-muted)]">
                  Never save for
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {status?.neverSave.map((origin) => (
                    <button
                      key={origin}
                      type="button"
                      onClick={() => {
                        void window.ncc.passwordsRemoveNever(origin).then(setStatus)
                      }}
                      className="inline-flex items-center gap-1 rounded border border-[color:var(--color-line)] px-1.5 py-0.5 font-mono text-ui-9 text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]"
                      title="Stop ignoring this site"
                    >
                      {origin}
                      <X className="h-2.5 w-2.5" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
              Import and export
            </h3>
            <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
              Import Chrome/Edge or Bitwarden CSV, or an encrypted vault event. Plaintext CSV
              export contains your passwords; store it carefully.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void importOpen()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void exportVault('encrypted')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                Export encrypted
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void exportVault('csv')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-warn)]/30 px-2.5 py-1.5 text-ui-11 text-[color:var(--color-warn)] hover:bg-[color:var(--color-warn)]/10 disabled:opacity-40"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                {exportArmed ? 'Confirm plaintext CSV export' : 'Export CSV'}
              </button>
            </div>

            {importPreview ? (
              <div className="mt-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
                <p className="text-ui-11 font-medium text-[color:var(--color-text-strong)]">
                  {importPreview.count} login{importPreview.count === 1 ? '' : 's'} found
                  {importPreview.duplicates > 0
                    ? ` · ${importPreview.duplicates} duplicate${importPreview.duplicates === 1 ? '' : 's'}`
                    : ''}
                  {' · '}
                  {Math.round(importPreview.projectedBytes / 1024)} KB projected
                </p>
                {importPreview.error ? (
                  <p className="mt-1 text-ui-105 text-[color:var(--color-warn)]">
                    {importPreview.error}
                  </p>
                ) : null}
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {importPreview.entries.slice(0, 8).map((entry) => (
                    <li key={`${entry.origin}/${entry.username}`} className="truncate text-ui-105 text-[color:var(--color-muted)]">
                      {entry.title || entry.origin} · {entry.username || 'no username'}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value={importMode}
                    onChange={(event) =>
                      setImportMode(event.target.value as 'merge' | 'skip' | 'add')
                    }
                    className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-2 py-1 text-ui-105 text-[color:var(--color-text)]"
                  >
                    <option value="merge">Update duplicates</option>
                    <option value="skip">Skip duplicates</option>
                    <option value="add">Add duplicates</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void importCommit()}
                    className="rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1 text-ui-105 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40"
                  >
                    Import
                  </button>
                  <button
                    type="button"
                    onClick={() => setImportPreview(null)}
                    className="text-ui-105 text-[color:var(--color-muted)] hover:text-[color:var(--color-text-strong)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      <PaymentCardsSettings passwords={status} />
    </>
  )
}

function Heading() {
  return (
    <div>
      <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">Passwords</h2>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        An encrypted login list stored as a NIP-78 event on Nostr. Only your identity can
        decrypt it; pages never receive the vault.
      </p>
    </div>
  )
}

function PasswordHealthPanel({
  health,
  onEdit
}: {
  health: PasswordHealthReport | null
  onEdit: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (!health || health.entries.length === 0) return null

  return (
    <div className="rounded-xl border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warn)]" />
          <div>
            <p className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
              Password health
            </p>
            <p className="mt-0.5 text-ui-105 text-[color:var(--color-muted)]">
              {[
                health.weakCount > 0 ? `${health.weakCount} weak` : null,
                health.reusedCount > 0 ? `${health.reusedCount} reused` : null,
                health.oldCount > 0 ? `${health.oldCount} due for rotation` : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="text-ui-105 text-[color:var(--color-accent)] hover:underline"
        >
          {expanded ? 'Hide' : 'Review'}
        </button>
      </div>

      {expanded ? (
        <ul className="mt-3 space-y-1.5">
          {health.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-ui-105 font-medium text-[color:var(--color-text-strong)]">
                  {entry.title || entry.origin}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-ui-9 text-[color:var(--color-muted)]">
                  {healthFlags(entry)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onEdit(entry.id)}
                className="shrink-0 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-9 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function healthFlags(entry: PasswordHealthEntry): React.ReactNode {
  const flags: Array<{ key: string; label: string; icon: React.ReactNode }> = []
  if (entry.weak) flags.push({ key: 'weak', label: 'Weak', icon: <AlertTriangle className="h-3 w-3" /> })
  if (entry.reused) flags.push({ key: 'reused', label: 'Reused', icon: <Repeat className="h-3 w-3" /> })
  if (entry.old) flags.push({ key: 'old', label: 'Due for rotation', icon: <RefreshCw className="h-3 w-3" /> })
  return (
    <>
      {flags.map((flag) => (
        <span key={flag.key} className="inline-flex items-center gap-1">
          {flag.icon}
          {flag.label}
        </span>
      ))}
    </>
  )
}

function PasswordForm({
  draft,
  editing,
  reveal,
  busy,
  error,
  onChange,
  onToggleReveal,
  onGenerate,
  onCancel,
  onSave
}: {
  draft: PasswordDraft
  editing: boolean
  reveal: boolean
  busy: boolean
  error: string | null
  onChange: (patch: Partial<PasswordDraft>) => void
  onToggleReveal: () => void
  onGenerate: () => void
  onCancel: () => void
  onSave: () => void
}) {
  const originRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) originRef.current?.focus()
  }, [editing])

  return (
    <div className="rounded-xl border border-[color:var(--color-accent)]/30 bg-[color:var(--color-panel-raised)] p-4">
      <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
        {editing ? 'Edit login' : 'Add login'}
      </h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => onChange({ title: event.target.value })}
            placeholder="Example"
            className={inputClass}
          />
        </Field>
        <Field label="Origin">
          <input
            ref={originRef}
            value={draft.origin}
            onChange={(event) => onChange({ origin: event.target.value })}
            placeholder="https://example.com or ncc://npub…/service"
            spellCheck={false}
            className={cn(inputClass, 'font-mono')}
          />
        </Field>
        <Field label="Username">
          <input
            value={draft.username}
            onChange={(event) => onChange({ username: event.target.value })}
            autoComplete="off"
            className={inputClass}
          />
        </Field>
        <Field label="Password">
          <div className="flex gap-1.5">
            <input
              type={reveal ? 'text' : 'password'}
              value={draft.password}
              onChange={(event) => onChange({ password: event.target.value })}
              autoComplete="new-password"
              className={cn(inputClass, 'min-w-0 flex-1 font-mono')}
            />
            <button
              type="button"
              onClick={onToggleReveal}
              aria-label={reveal ? 'Hide password' : 'Show password'}
              className="rounded-lg border border-[color:var(--color-line)] px-2 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={onGenerate}
              aria-label="Generate password"
              title="Generate a strong password"
              className="rounded-lg border border-[color:var(--color-line)] px-2 text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent)]/10"
            >
              <Wand2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <PasswordStrengthMeter password={draft.password} />
        </Field>
        <Field label="2FA secret or otpauth:// URI">
          <input
            type="password"
            value={draft.totp}
            onChange={(event) => onChange({ totp: event.target.value })}
            placeholder="Optional"
            spellCheck={false}
            autoComplete="off"
            className={cn(inputClass, 'font-mono')}
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={draft.notes}
            onChange={(event) => onChange({ notes: event.target.value })}
            rows={2}
            className={cn(inputClass, 'resize-y')}
          />
        </Field>
      </div>
      {error ? (
        <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-danger)]">{error}</p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          data-password-form-save
          disabled={busy || !draft.origin.trim()}
          onClick={onSave}
          className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40"
        >
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Save login'}
        </button>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]/60'

const STRENGTH_BAR_COLOR = [
  'bg-[color:var(--color-danger)]',
  'bg-[color:var(--color-danger)]',
  'bg-[color:var(--color-warn)]',
  'bg-[color:var(--color-ok)]',
  'bg-[color:var(--color-ok)]'
]

function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null
  const strength = scorePassword(password)
  const filledBars = Math.min(strength.score + 1, 4)
  return (
    <div className="mt-1.5" data-password-strength={strength.score}>
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((segment) => (
          <span
            key={segment}
            className={cn(
              'h-1 flex-1 rounded-full bg-[color:var(--color-line)]',
              segment < filledBars && STRENGTH_BAR_COLOR[strength.score]
            )}
          />
        ))}
      </div>
      <p className="mt-1 text-ui-9 text-[color:var(--color-muted)]">
        {strength.label}
        {strength.warning ? ` · ${strength.warning}` : ''}
      </p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-ui-105 text-[color:var(--color-muted)]">
      {label}
      {children}
    </label>
  )
}

function RowButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
    >
      {children}
    </button>
  )
}

function TotpCell({
  id,
  onCopy
}: {
  id: string
  onCopy: (id: string, field: 'username' | 'password' | 'totp') => void
}) {
  const [code, setCode] = useState<PasswordTotpCode | null>(null)
  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      try {
        const next = await window.ncc.passwordsTotp(id)
        if (!alive) return
        setCode(next)
        timer = window.setTimeout(tick, Math.max(500, next.remaining * 1000))
      } catch {
        // leave the cell empty
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [id])
  return (
    <button
      type="button"
      onClick={() => void onCopy(id, 'totp')}
      title="Copy 2FA code"
      className="shrink-0 rounded-lg border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-1.5 py-1 font-mono text-ui-10 tabular-nums text-[color:var(--color-accent)]"
    >
      {code?.code ?? '•••'}
    </button>
  )
}

function emptyDraft(origin = ''): PasswordDraft {
  return {
    origin,
    title: origin ? titleFromOrigin(origin) : '',
    username: '',
    password: '',
    notes: '',
    totp: ''
  }
}

function titleFromOrigin(origin: string): string {
  try {
    const url = new URL(origin)
    return url.hostname || origin
  } catch {
    return origin
  }
}

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}
