import { useEffect, useState } from 'react'
import {
  Copy,
  KeyRound,
  LockKeyhole,
  Plus,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Unlock
} from 'lucide-react'
import type { PasswordContext, PasswordSummary, PasswordTotpCode } from '@shared/passwords'
import { cn } from '../lib/cn'
import { Popover, type PopoverAnchor } from './Popover'

interface PasswordsPanelProps {
  context: PasswordContext | null
  anchor: PopoverAnchor | null
  busy: boolean
  error: string | null
  onClose: () => void
  onUnlock: () => void
  onLock: () => void
  onFill: (id: string) => void
  onCopy: (id: string, field: 'username' | 'password' | 'totp') => void
  onAdd: () => void
  onManage: () => void
}

export function PasswordsPanel({
  context,
  anchor,
  busy,
  error,
  onClose,
  onUnlock,
  onLock,
  onFill,
  onCopy,
  onAdd,
  onManage
}: PasswordsPanelProps) {
  const status = context?.status
  const origin = context?.origin ?? null
  const matches = context?.matches ?? []
  const passkeys = context?.passkeys ?? []

  return (
    <Popover
      title="Passwords"
      subtitle={origin ?? 'Encrypted with your Nostr identity'}
      testId="passwords"
      anchor={anchor}
      widthPx={380}
      onClose={onClose}
    >
      {!status?.configured ? (
        <Empty
          icon={LockKeyhole}
          title="Set up an identity first"
          body="Your Nostr key encrypts the vault. Import or generate one in Identity & signer."
          action={{ label: 'Open settings', onClick: onManage }}
        />
      ) : !status.unlocked ? (
        <Empty
          icon={LockKeyhole}
          title="Password manager is locked"
          body="Unlock with your Nostr identity. The vault auto-locks after a period of inactivity."
          action={{ label: busy ? 'Unlocking…' : 'Unlock', onClick: onUnlock }}
        />
      ) : context?.warning && context.tabKind === 'private' ? (
        <Empty icon={ShieldAlert} title="Private tab" body={context.warning} />
      ) : context?.scheme === 'http' ? (
        <Empty icon={ShieldAlert} title="Insecure page" body={context.warning ?? ''} />
      ) : !origin ? (
        <Empty
          icon={KeyRound}
          title="No page selected"
          body="Open a website or an ncc:// service to use a saved login."
          action={{ label: 'Manage passwords', onClick: onManage }}
        />
      ) : (
        <div className="space-y-1.5">
          {context?.warning ? (
            <p className="flex items-start gap-2 rounded-lg border border-[color:var(--color-warn)]/25 bg-[color:var(--color-warn)]/10 px-2.5 py-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
              <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {context.warning}
            </p>
          ) : null}

          {matches.length || passkeys.length ? (
            <ul className="space-y-1" data-password-matches>
              {matches.map((entry) => (
                <PasswordRow
                  key={entry.id}
                  entry={entry}
                  onFill={onFill}
                  onCopy={onCopy}
                />
              ))}
              {passkeys.map((entry) => (
                <PasskeyRow key={entry.id} entry={entry} />
              ))}
            </ul>
          ) : (
            <Empty
              icon={KeyRound}
              title="No saved login for this site"
              body={
                context?.formDetected
                  ? 'A login form was detected. Add a login or save one after signing in.'
                  : 'Add a login for this origin. Passwords are matched by exact origin.'
              }
              action={{ label: 'Add login for this site', onClick: onAdd }}
            />
          )}

          {matches.length || passkeys.length ? (
            <button
              type="button"
              data-password-add
              onClick={onAdd}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another login for this site
            </button>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="px-2.5 py-2 text-ui-11 leading-relaxed text-[color:var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <div className="mt-1 flex items-center justify-between gap-2 border-t border-[color:var(--color-line)] px-1 pt-2">
        <button
          type="button"
          onClick={onManage}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Manage passwords
        </button>
        {status?.configured ? (
          status.unlocked ? (
            <button
              type="button"
              onClick={onLock}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
            >
              <LockKeyhole className="h-3.5 w-3.5" />
              Lock
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onUnlock}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-105 text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent)]/10 disabled:opacity-40"
            >
              <Unlock className="h-3.5 w-3.5" />
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          )
        ) : null}
      </div>
    </Popover>
  )
}

function PasswordRow({
  entry,
  onFill,
  onCopy
}: {
  entry: PasswordSummary
  onFill: (id: string) => void
  onCopy: (id: string, field: 'username' | 'password' | 'totp') => void
}) {
  return (
    <li className="rounded-lg border border-transparent hover:border-[color:var(--color-line)] hover:bg-[color:var(--color-hover-soft)]">
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-password-fill={entry.id}
          onClick={() => onFill(entry.id)}
          className="min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left"
          title={`Fill ${entry.username || entry.title}`}
        >
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-ok)]" />
            <span className="truncate text-ui-115 font-medium text-[color:var(--color-text-strong)]">
              {entry.title || entry.origin}
            </span>
          </span>
          <span className="mt-0.5 block truncate pl-5 text-ui-105 text-[color:var(--color-muted)]">
            {entry.username || 'No username'}
          </span>
        </button>
        {entry.hasTotp ? <TotpButton entry={entry} onCopy={onCopy} /> : null}
        <IconButton
          label="Copy username"
          onClick={() => onCopy(entry.id, 'username')}
          icon={<Copy className="h-3.5 w-3.5" />}
        />
        <IconButton
          label="Copy password"
          onClick={() => onCopy(entry.id, 'password')}
          icon={<KeyRound className="h-3.5 w-3.5" />}
        />
      </div>
    </li>
  )
}

function PasskeyRow({ entry }: { entry: PasswordSummary }) {
  return (
    <li className="flex items-center gap-2 rounded-lg px-2.5 py-2" data-password-passkey={entry.id}>
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-accent)]" />
      <span className="min-w-0 flex-1 truncate text-ui-11 font-medium text-[color:var(--color-text-strong)]">
        {entry.username || entry.title || 'Passkey'}
      </span>
      <span className="rounded border border-[color:var(--color-accent)]/30 px-1.5 py-0.5 text-ui-9 text-[color:var(--color-accent)]">
        Passkey
      </span>
    </li>
  )
}

function TotpButton({
  entry,
  onCopy
}: {
  entry: PasswordSummary
  onCopy: (id: string, field: 'username' | 'password' | 'totp') => void
}) {
  const [code, setCode] = useState<PasswordTotpCode | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      try {
        const next = await window.ncc.passwordsTotp(entry.id)
        if (!alive) return
        setCode(next)
        setError(false)
        timer = window.setTimeout(tick, Math.max(500, next.remaining * 1000))
      } catch {
        if (alive) setError(true)
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [entry.id])

  return (
    <button
      type="button"
      data-password-totp={entry.id}
      title={error ? 'TOTP unavailable' : `Copy 2FA code (${code?.remaining ?? 0}s)`}
      onClick={() => onCopy(entry.id, 'totp')}
      className={cn(
        'shrink-0 rounded-lg border px-1.5 py-1 font-mono text-ui-10 tabular-nums',
        error
          ? 'border-[color:var(--color-danger)]/30 text-[color:var(--color-danger)]'
          : 'border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
      )}
    >
      {error ? '2FA' : (code?.code ?? '•••')}
    </button>
  )
}

function IconButton({
  label,
  onClick,
  icon
}: {
  label: string
  onClick: () => void
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
    >
      {icon}
    </button>
  )
}

function Empty({
  icon: Icon,
  title,
  body,
  action
}: {
  icon: typeof LockKeyhole
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="px-3 py-7 text-center">
      <Icon className="mx-auto h-5 w-5 text-[color:var(--color-faint-dim)]" />
      <p className="mt-2 text-ui-12 font-medium text-[color:var(--color-text-strong)]">{title}</p>
      <p className="mx-auto mt-1 max-w-[300px] text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {body}
      </p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-3 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
