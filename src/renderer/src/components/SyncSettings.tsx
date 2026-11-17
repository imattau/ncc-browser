import { useCallback, useEffect, useState } from 'react'
import { Bookmark, Clock, Laptop, Monitor, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import type { IdentityStatus } from '@shared/types'
import type { SyncCategory, SyncDevice, SyncStatus } from '@shared/sync-status'
import { cn } from '../lib/cn'

interface SyncSettingsProps {
  identity: IdentityStatus | null
  onOpenIdentity: () => void
}

const CATEGORIES: Array<{
  id: SyncCategory
  label: string
  hint: string
  icon: typeof Bookmark
}> = [
  {
    id: 'bookmarks',
    label: 'Bookmarks',
    hint: 'Starred pages. Removing one here removes it on your other devices.',
    icon: Bookmark
  },
  {
    id: 'tabs',
    label: 'Open tabs',
    hint: 'The normal tabs open on this device, so your other devices can open them. Private and Tor tabs are never shared.',
    icon: Monitor
  },
  {
    id: 'history',
    label: 'History',
    hint: 'The last eight weeks of normal-tab history, used for address-bar suggestions. Clearing history clears it on every device. Relays can see how big the document is and when it changes, though not what is in it.',
    icon: Clock
  }
]

export function SyncSettings({ identity, onOpenIdentity }: SyncSettingsProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = useCallback((next: SyncStatus): void => {
    setStatus(next)
    setName((current) => current || next.deviceName)
  }, [])

  useEffect(() => {
    let alive = true
    void window.ncc.syncStatus().then((next) => alive && apply(next))
    const off = window.ncc.onSyncStatus((next) => alive && setStatus(next))
    return () => {
      alive = false
      off()
    }
  }, [apply])

  const toggle = async (id: SyncCategory, value: boolean): Promise<void> => {
    setBusy(true)
    try {
      apply(await window.ncc.syncConfigure({ categories: { [id]: value } }))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (): Promise<void> => {
    const value = name.trim()
    if (!value || value === status?.deviceName) return
    apply(await window.ncc.syncConfigure({ deviceName: value }))
  }

  if (!status) return null
  const anyOn = Object.values(status.categories).some(Boolean)

  return (
    <div className="space-y-5" data-sync-settings>
      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">Sync</h2>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Keep bookmarks, open tabs and history in step across your devices. Everything is
          encrypted to your own Nostr key before it leaves this device and stored on your relays,
          so only you can read it. Passwords sync separately, in their own vault.
        </p>
      </div>

      {!status.identity ? (
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-12 text-[color:var(--color-muted)]">
          Sync is encrypted to your identity, so it needs one first.{' '}
          <button
            type="button"
            onClick={onOpenIdentity}
            className="text-[color:var(--color-accent)] underline-offset-2 hover:underline"
          >
            Set up an identity
          </button>
          {identity ? null : '.'}
        </div>
      ) : null}

      <div className="space-y-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        {CATEGORIES.map((category) => {
          const Icon = category.icon
          return (
            <label
              key={category.id}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5"
            >
              <input
                type="checkbox"
                data-sync-category={category.id}
                checked={status.categories[category.id]}
                disabled={busy || !status.identity}
                onChange={(event) => void toggle(category.id, event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                  <Icon className="h-3.5 w-3.5 text-[color:var(--color-faint)]" />
                  {category.label}
                </span>
                <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                  {category.hint}
                </span>
              </span>
            </label>
          )
        })}

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="button"
            disabled={!anyOn || status.syncing || !status.identity}
            onClick={() => void window.ncc.syncNow().then(apply)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-12 text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', status.syncing && 'animate-spin')} />
            Sync now
          </button>
          <span className="text-ui-115 text-[color:var(--color-muted)]" data-sync-state>
            {status.error
              ? status.error
              : status.syncing
                ? 'Syncing…'
                : status.lastSyncedAt
                  ? `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}`
                  : anyOn
                    ? 'Waiting for the first sync'
                    : 'Off'}
          </span>
        </div>
        {status.error ? (
          <p className="text-ui-115 text-[color:var(--color-danger)]">
            Your data is still saved on this device. Sync will try again.
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <label
          htmlFor="sync-device-name"
          className="mb-1.5 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
        >
          This device
        </label>
        <input
          id="sync-device-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void rename()
          }}
          className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
        />

        <p className="mb-1.5 mt-4 text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
          Your other devices
        </p>
        {status.devices.length === 0 ? (
          <p className="text-ui-115 text-[color:var(--color-muted)]">
            {status.categories.tabs
              ? 'None yet. Turn on open tabs on your other devices, then sync.'
              : 'Turn on open tabs to see tabs from your other devices.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {status.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onRemove={() => void window.ncc.syncRemoveDevice(device.id).then(apply)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function DeviceIcon({ platform, className }: { platform: string; className?: string }) {
  const Icon = platform === 'android' || platform === 'ios' ? Smartphone : Laptop
  return <Icon className={className} />
}

function DeviceRow({ device, onRemove }: { device: SyncDevice; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
      <DeviceIcon platform={device.platform} className="h-4 w-4 shrink-0 text-[color:var(--color-faint)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-12 font-medium text-[color:var(--color-text-strong)]">
          {device.name}
        </span>
        <span className="block text-ui-11 text-[color:var(--color-muted)]">
          {device.tabs.length} {device.tabs.length === 1 ? 'tab' : 'tabs'} · updated{' '}
          {new Date(device.updatedAt).toLocaleString()}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${device.name}`}
        title="Remove from this list. It comes back the next time that device syncs."
        onClick={onRemove}
        className="rounded p-1 text-[color:var(--color-faint)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
