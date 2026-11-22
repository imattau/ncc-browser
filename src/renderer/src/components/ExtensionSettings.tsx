import { useCallback, useEffect, useState } from 'react'
import {
  ExternalLink,
  FolderOpen,
  PackagePlus,
  Puzzle,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import type { ExtensionInfo, ExtensionsState } from '@shared/extensions'
import { cn } from '../lib/cn'
import { messageOf } from '../lib/format'

export function ExtensionSettings() {
  const [state, setState] = useState<ExtensionsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState(await window.ncc.extensionsState())
  }, [])

  useEffect(() => {
    void load().catch((loadError) => setError(messageOf(loadError)))
    return window.ncc.onExtensions(setState)
  }, [load])

  const run = async (action: () => Promise<ExtensionsState | unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (next && typeof next === 'object' && 'extensions' in next) {
        setState(next as ExtensionsState)
      } else {
        await load()
      }
    } catch (runError) {
      setError(messageOf(runError))
    } finally {
      setBusy(false)
    }
  }

  const install = async (kind: 'folder' | 'zip'): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.ncc.extensionsInstall(kind)
      if (!result.ok) {
        if (result.error !== 'Install cancelled') setError(result.error ?? 'Could not install')
        return
      }
      setNotice(`${result.extension?.name ?? 'Extension'} installed.`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (confirmRemove !== id) {
      setConfirmRemove(id)
      return
    }
    setConfirmRemove(null)
    await run(() => window.ncc.extensionsRemove(id))
  }

  if (!state) {
    return (
      <>
        <Heading />
        <p className="text-ui-11 text-[color:var(--color-muted)]">Loading extensions…</p>
      </>
    )
  }

  return (
    <>
      <Heading />

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
              Installed extensions
            </p>
            <p className="text-ui-105 text-[color:var(--color-muted)]">
              {state.extensions.length === 0
                ? 'No extensions installed.'
                : `${state.extensions.length} installed · ${state.actions.length} with toolbar actions`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !state.developerMode}
              onClick={() => void install('folder')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
              title={
                state.developerMode
                  ? 'Load an unpacked extension folder'
                  : 'Enable developer mode first'
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Load unpacked
            </button>
            <button
              type="button"
              data-extension-install-zip
              disabled={busy}
              onClick={() => void install('zip')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40"
            >
              <PackagePlus className="h-3.5 w-3.5" />
              Install package
            </button>
          </div>
        </div>

        <label className="mt-3 flex cursor-pointer items-start gap-2 text-ui-11 text-[color:var(--color-muted)]">
          <input
            type="checkbox"
            data-extension-developer
            checked={state.developerMode}
            onChange={(event) =>
              void run(() => window.ncc.extensionsSetDeveloper(event.target.checked))
            }
            className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]"
          />
          <span>
            Developer mode
            <span className="mt-0.5 block text-ui-105 text-[color:var(--color-faint)]">
              Allows loading unpacked folders. Packages can always be installed.
            </span>
          </span>
        </label>

        {error ? (
          <p className="mt-3 rounded-lg border border-[color:var(--color-danger)]/25 bg-[color:var(--color-danger)]/10 px-2.5 py-2 text-ui-11 text-[color:var(--color-danger)]">
            {error}
          </p>
        ) : null}
        {notice ? <p className="mt-3 text-ui-11 text-[color:var(--color-ok)]">{notice}</p> : null}
      </div>

      {state.extensions.length === 0 ? (
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] px-4 py-10 text-center">
          <Puzzle className="mx-auto h-6 w-6 text-[color:var(--color-faint-dim)]" />
          <p className="mt-2 text-ui-12 font-medium text-[color:var(--color-text-strong)]">
            No extensions yet
          </p>
          <p className="mx-auto mt-1 max-w-lg text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
            Extensions use the Manifest V3 model with a supported subset of the{' '}
            <code className="font-mono">chrome.*</code> APIs and NCC-specific Nostr APIs.
            Content scripts run on both <code className="font-mono">https://</code> and{' '}
            <code className="font-mono">ncc://</code> pages.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-extension-list>
          {state.extensions.map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              busy={busy}
              confirmRemove={confirmRemove === extension.id}
              onToggle={(value) =>
                void run(() => window.ncc.extensionsSetEnabled(extension.id, value))
              }
              onPrivate={(value) =>
                void run(() => window.ncc.extensionsSetPrivate(extension.id, value))
              }
              onReload={() => void run(() => window.ncc.extensionsReload(extension.id))}
              onOptions={() => void window.ncc.extensionsOpenOptions(extension.id)}
              onReveal={() => void window.ncc.extensionsReveal(extension.id)}
              onRemove={() => void remove(extension.id)}
            />
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <h3 className="flex items-center gap-1.5 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
          <ShieldAlert className="h-3.5 w-3.5 text-[color:var(--color-warn)]" />
          Extension boundaries
        </h3>
        <ul className="mt-2 space-y-1.5 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          <li>
            Extensions are trusted code. Installing one is equivalent to running a program with
            access to the pages it matches.
          </li>
          <li>
            Extensions never run in Tor tabs. Private tabs require the per-extension grant and
            write to an ephemeral storage area when they use{' '}
            <code className="font-mono">ncc.storage.private</code>.
          </li>
          <li>
            Nostr signing always goes through the approval sheet unless you choose “Always
            allow” for that extension.
          </li>
          <li>Packages are not signed in this version; check the source path before installing.</li>
        </ul>
      </div>
    </>
  )
}

function ExtensionCard({
  extension,
  busy,
  confirmRemove,
  onToggle,
  onPrivate,
  onReload,
  onOptions,
  onReveal,
  onRemove
}: {
  extension: ExtensionInfo
  busy: boolean
  confirmRemove: boolean
  onToggle: (value: boolean) => void
  onPrivate: (value: boolean) => void
  onReload: () => void
  onOptions: () => void
  onReveal: () => void
  onRemove: () => void
}) {
  return (
    <li
      className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-3"
      data-extension-id={extension.id}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color:var(--color-field)]">
          {extension.iconDataUrl ? (
            <img src={extension.iconDataUrl} alt="" className="h-7 w-7" />
          ) : (
            <Puzzle className="h-4 w-4 text-[color:var(--color-muted)]" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
            {extension.name}
            <span className="rounded border border-[color:var(--color-line)] px-1 py-0.5 font-mono text-ui-9 font-normal text-[color:var(--color-muted)]">
              {extension.version}
            </span>
            {extension.enabled ? (
              <span className="inline-flex items-center gap-1 text-ui-9 text-[color:var(--color-ok)]">
                <ShieldCheck className="h-3 w-3" /> enabled
              </span>
            ) : (
              <span className="text-ui-9 text-[color:var(--color-faint)]">disabled</span>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-ui-105 text-[color:var(--color-muted)]">
            {extension.source} · {extension.sourcePath}
          </p>
          {extension.description ? (
            <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
              {extension.description}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {extension.permissions.map((permission) => (
              <span
                key={permission}
                className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 font-mono text-ui-9 text-[color:var(--color-muted)]"
              >
                {permission}
              </span>
            ))}
            {extension.hostPermissions.map((host) => (
              <span
                key={host}
                className="rounded border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-1.5 py-0.5 font-mono text-ui-9 text-[color:var(--color-accent)]"
              >
                {host}
              </span>
            ))}
          </div>
          {extension.warnings.length > 0 ? (
            <p className="mt-1.5 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
              {extension.warnings.join(' · ')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-label={extension.enabled ? 'Disable extension' : 'Enable extension'}
            title={extension.enabled ? 'Disable' : 'Enable'}
            data-extension-toggle={extension.id}
            disabled={busy}
            onClick={() => onToggle(!extension.enabled)}
            className={cn(
              'rounded-lg border px-2 py-1 text-ui-10',
              extension.enabled
                ? 'border-[color:var(--color-ok)]/30 text-[color:var(--color-ok)]'
                : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
            )}
          >
            {extension.enabled ? 'On' : 'Off'}
          </button>
          <IconButton label="Reload extension" onClick={onReload} disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Show files" onClick={onReveal}>
            <ExternalLink className="h-3.5 w-3.5" />
          </IconButton>
          {extension.hasOptions ? (
            <IconButton label="Extension options" onClick={onOptions}>
              <Settings2 className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          <button
            type="button"
            aria-label={confirmRemove ? 'Confirm remove extension' : 'Remove extension'}
            title={confirmRemove ? 'Click again to remove' : 'Remove extension'}
            disabled={busy}
            onClick={onRemove}
            className={cn(
              'rounded-lg px-2 py-1 text-ui-10',
              confirmRemove
                ? 'bg-[color:var(--color-danger)] text-[color:var(--color-on-danger)]'
                : 'text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]'
            )}
          >
            {confirmRemove ? 'Remove?' : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[color:var(--color-line)] pt-2 text-ui-105 text-[color:var(--color-muted)]">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={extension.privateTabs}
            onChange={(event) => onPrivate(event.target.checked)}
            className="h-3 w-3 accent-[color:var(--color-accent)]"
          />
          Run in private tabs
        </label>
        <span className="text-[color:var(--color-faint)]">
          {extension.contentScriptCount} content script
          {extension.contentScriptCount === 1 ? '' : 's'}
          {extension.hasBackground ? ' · background' : ''}
          {extension.hasPopup ? ' · popup' : ''}
        </span>
      </div>
    </li>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function Heading() {
  return (
    <div>
      <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">
        Extensions
      </h2>
      <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        Manifest V3 extensions with a supported <code className="font-mono">chrome.*</code>{' '}
        subset and NCC-native Nostr APIs. Content scripts work on both web and{' '}
        <code className="font-mono">ncc://</code> pages.
      </p>
    </div>
  )
}
