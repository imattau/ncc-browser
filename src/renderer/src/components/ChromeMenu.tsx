import { useEffect, useRef } from 'react'
import { Bookmark as BookmarkIcon, Server, Smartphone, WalletCards, X } from 'lucide-react'
import { COMMANDS, COMMAND_ORDER, type CommandId } from '@shared/commands'
import type { Bookmark, IdentityStatus, NavState } from '@shared/types'
import type { SyncDevice } from '@shared/sync-status'
import { DeviceIcon } from './SyncSettings'
import { cn } from '../lib/cn'
import { useFocusTrap } from '../lib/useFocusTrap'

interface ChromeMenuProps {
  state: NavState
  identity: IdentityStatus | null
  bookmarks: Bookmark[]
  onCommand: (command: CommandId) => void
  onOpenWallet: () => void
  onPublishService: (url: string) => void
  onOpenBookmark: (url: string) => void
  onRemoveBookmark: (url: string) => void
  devices?: SyncDevice[]
  onOpenDeviceTab?: (url: string) => void
  onClose: () => void
}

export function ChromeMenu({
  state,
  identity,
  bookmarks,
  onCommand,
  onOpenWallet,
  onPublishService,
  onOpenBookmark,
  onRemoveBookmark,
  devices = [],
  onOpenDeviceTab,
  onClose
}: ChromeMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(true, ref)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const isMac = navigator.platform.toLowerCase().includes('mac')
  const publishUrl = loopbackServiceUrl(state.displayUrl)

  return (
    <div
      className="fixed inset-0 z-[95] bg-[color:var(--color-scrim)] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="menu"
        data-chrome-menu
        aria-label="Browser menu"
        className="ncc-fade-in absolute right-3 top-[104px] max-h-[72vh] w-[312px] overflow-y-auto rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] py-1.5 shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[color:var(--color-line)] px-3 pb-2.5 pt-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui-11 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
              Nostr Navigator
            </span>
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-ui-10',
                identity?.mode === 'nip46'
                  ? 'border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
              )}
            >
              {identity?.mode === 'nip46'
                ? 'remote signer'
                : identity?.configured
                  ? 'local key'
                  : 'no identity'}
            </span>
          </div>
          {identity?.npub ? (
            <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-ui-10 text-[color:var(--color-faint)]">
              {identity.mode === 'nip46' ? <Smartphone className="h-3 w-3 shrink-0" /> : null}
              {identity.npub.slice(0, 18)}…{identity.npub.slice(-6)}
            </p>
          ) : null}
        </div>

        <div className="px-1.5 pt-1.5">
          <button type="button" role="menuitem" onClick={onOpenWallet} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-12 text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-hover)]">
            <WalletCards className="h-4 w-4 text-[color:var(--color-accent)]" /> Wallet
          </button>
          {publishUrl ? (
            <button
              type="button"
              role="menuitem"
              data-command="publish-service"
              onClick={() => onPublishService(publishUrl)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-12 text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-hover)]"
            >
              <Server className="h-4 w-4 text-[color:var(--color-accent)]" /> Publish this page…
            </button>
          ) : null}
        </div>

        {COMMAND_ORDER.map((group) => {
          const items = COMMANDS.filter((command) => command.group === group)
          if (items.length === 0) return null

          return (
            <div key={group} className="px-1.5 pt-1.5">
              <p className="px-2 py-1 text-ui-95 font-semibold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
                {group}
              </p>
              {items.map((command) => {
                const enabled = isEnabled(command.id, state)
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="menuitem"
                    data-command={command.id}
                    disabled={!enabled}
                    onClick={() => onCommand(command.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-ui-12 transition-colors',
                      enabled
                        ? 'text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-hover)]'
                        : 'cursor-default text-[color:var(--color-faint-dim)]'
                    )}
                  >
                    <span className="truncate">{command.label}</span>
                    {command.shortcut ? (
                      <span className="shrink-0 font-mono text-ui-10 text-[color:var(--color-muted)]">
                        {isMac
                          ? command.shortcut.replace('Ctrl', '⌘').replace('Alt', '⌥')
                          : command.shortcut}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )
        })}

        {bookmarks.length > 0 ? (
          <div className="mt-1 border-t border-[color:var(--color-line)] px-1.5 pb-1 pt-1.5">
            <p className="px-2 py-1 text-ui-95 font-semibold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
              Bookmarks
            </p>
            {bookmarks.slice(0, 12).map((bookmark) => (
              <div key={bookmark.url} className="group flex items-center gap-1">
                <button
                  type="button"
                  role="menuitem"
                  data-bookmark-url={bookmark.url}
                  onClick={() => onOpenBookmark(bookmark.url)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-12 text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-hover)]"
                >
                  <BookmarkIcon className="h-3 w-3 shrink-0 text-[color:var(--color-warn)]" />
                  <span className="truncate">{bookmark.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove bookmark ${bookmark.title}`}
                  title="Remove bookmark"
                  onClick={() => onRemoveBookmark(bookmark.url)}
                  className="shrink-0 rounded p-1 text-[color:var(--color-faint)] opacity-0 hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)] group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {bookmarks.length > 12 ? (
              <p className="px-2 py-1 text-ui-105 text-[color:var(--color-faint)]">
                +{bookmarks.length - 12} more…
              </p>
            ) : null}
          </div>
        ) : null}

        {devices.map((device) => (
          <div
            key={device.id}
            data-sync-device={device.id}
            className="mt-1 border-t border-[color:var(--color-line)] px-1.5 pb-1 pt-1.5"
          >
            <p className="flex items-center gap-1.5 px-2 py-1 text-ui-95 font-semibold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
              <DeviceIcon platform={device.platform} className="h-3 w-3" />
              <span className="truncate">{device.name}</span>
            </p>
            {device.tabs.length === 0 ? (
              <p className="px-2 py-1 text-ui-105 text-[color:var(--color-faint)]">No open tabs</p>
            ) : null}
            {device.tabs.slice(0, 8).map((tab) => (
              <button
                key={tab.url}
                type="button"
                role="menuitem"
                data-sync-tab-url={tab.url}
                title={tab.url}
                onClick={() => onOpenDeviceTab?.(tab.url)}
                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-12 text-[color:var(--color-text-strong)] hover:bg-[color:var(--color-hover)]"
              >
                <span className="truncate">{tab.title}</span>
              </button>
            ))}
            {device.tabs.length > 8 ? (
              <p className="px-2 py-1 text-ui-105 text-[color:var(--color-faint)]">
                +{device.tabs.length - 8} more…
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A local service the user can publish without leaving the browser. */
function loopbackServiceUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)) {
      return url.origin
    }
    return null
  } catch {
    return null
  }
}

function isEnabled(id: CommandId, state: NavState): boolean {
  switch (id) {
    case 'close-tab':
    case 'reload':
    case 'force-reload':
    case 'toggle-page-devtools':
      return state.tabs.length > 0
    case 'next-tab':
    case 'previous-tab':
      return state.tabs.length > 1
    case 'back':
      return state.canGoBack
    case 'forward':
      return state.canGoForward
    case 'stop':
      return state.loading
    case 'toggle-bookmark':
    case 'open-history':
      return state.mode !== 'blank'
    default:
      return true
  }
}
