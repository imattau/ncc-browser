import { useRef } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Download,
  History,
  KeyRound,
  Menu,
  RotateCw,
  X
} from 'lucide-react'
import type { DownloadNotice, IdentityStatus, NavState } from '@shared/types'
import { isActiveDownload } from '@shared/downloads'
import { AddressBar } from './AddressBar'
import type { PopoverAnchor } from './Popover'
import { securitySummary } from '../lib/security'
import { cn } from '../lib/cn'

interface ToolbarProps {
  state: NavState
  hint: string | null
  identity: IdentityStatus | null
  signerPending: boolean
  bookmarked: boolean
  downloads: DownloadNotice[]
  onNavigate: (input: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onToggleBookmark: () => void
  onToggleTor: () => void
  onOpenDownloads: () => void
  onOpenHistory: () => void
  onHistoryMenu: (direction: 'back' | 'forward') => void
  onOpenSiteInfo: (anchor: PopoverAnchor) => void
  onOpenSettings: () => void
  onOpenMenu: () => void
}

export function Toolbar({
  state,
  hint,
  identity,
  signerPending,
  bookmarked,
  downloads,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onToggleBookmark,
  onToggleTor,
  onOpenDownloads,
  onOpenHistory,
  onHistoryMenu,
  onOpenSiteInfo,
  onOpenSettings,
  onOpenMenu
}: ToolbarProps) {
  const activeDownloads = downloads.filter((notice) => isActiveDownload(notice.state)).length
  const security = securitySummary(state)

  return (
    <header className="relative z-10 flex h-[60px] shrink-0 items-center gap-2 border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-3">
      <NavButton
        label="Back (Alt+←) — right-click or hold for history"
        disabled={!state.canGoBack}
        onClick={onBack}
        onContextMenu={() => onHistoryMenu('back')}
        onLongPress={() => onHistoryMenu('back')}
      >
        <ArrowLeft className="h-4 w-4" />
      </NavButton>
      <NavButton
        label="Forward (Alt+→) — right-click or hold for history"
        disabled={!state.canGoForward}
        onClick={onForward}
        onContextMenu={() => onHistoryMenu('forward')}
        onLongPress={() => onHistoryMenu('forward')}
      >
        <ArrowRight className="h-4 w-4" />
      </NavButton>
      <NavButton
        label={state.loading ? 'Stop (Esc)' : 'Refresh page, bypassing cache (Ctrl+Shift+R)'}
        onClick={state.loading ? onStop : onReload}
        disabled={state.mode === 'blank'}
      >
        {state.loading ? <X className="h-4 w-4" /> : <RotateCw className="h-3.5 w-3.5" />}
      </NavButton>
      <NavButton
        label="History (Ctrl+H)"
        onClick={onOpenHistory}
        disabled={state.mode === 'blank'}
      >
        <History className="h-4 w-4" />
      </NavButton>

      <AddressBar
        value={state.displayUrl}
        loading={state.loading}
        hint={hint}
        bookmarked={bookmarked}
        security={security}
        tor={state.tor}
        onToggleBookmark={onToggleBookmark}
        onToggleTor={onToggleTor}
        onOpenSiteInfo={onOpenSiteInfo}
        onNavigate={onNavigate}
      />

      {downloads.length > 0 ? (
        <button
          type="button"
          aria-label="Downloads"
          data-downloads-button
          title="Downloads (Ctrl+J)"
          onClick={onOpenDownloads}
          className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[color:var(--color-muted)] transition-colors hover:bg-white/5 hover:text-white"
        >
          <Download className="h-4 w-4" />
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold',
              activeDownloads > 0
                ? 'animate-pulse bg-[color:var(--color-accent)] text-[#0b0c10]'
                : 'bg-[#2a2f3c] text-[#c9d1e0]'
            )}
          >
            {activeDownloads || downloads.length}
          </span>
        </button>
      ) : null}

      <button
        type="button"
        aria-label="Nostr identity"
        data-signer-button
        title={signerTitle(identity)}
        onClick={onOpenSettings}
        className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[color:var(--color-muted)] transition-colors hover:bg-white/5 hover:text-white"
      >
        <KeyRound
          className={cn(
            'h-4 w-4',
            identity?.configured ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-muted)]'
          )}
        />
        {signerPending ? (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-warn)]" />
        ) : null}
      </button>

      <NavButton label="Menu" onClick={onOpenMenu}>
        <Menu className="h-4 w-4" />
      </NavButton>
    </header>
  )
}

function signerTitle(identity: IdentityStatus | null): string {
  if (!identity?.configured) return 'No Nostr identity — open settings'
  const mode = identity.mode === 'nip46' ? 'Remote signer' : 'Local key'
  const npub = identity.npub ?? ''
  return `${mode} · ${npub.length > 20 ? `${npub.slice(0, 14)}…` : npub}`
}

interface NavButtonProps {
  label: string
  disabled?: boolean
  onClick: () => void
  onContextMenu?: () => void
  onLongPress?: () => void
  children: React.ReactNode
}

function NavButton({
  label,
  disabled,
  onClick,
  onContextMenu,
  onLongPress,
  children
}: NavButtonProps) {
  const timer = useRef<number | null>(null)
  const longPressed = useRef(false)

  const cancelLongPress = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        // A long press opens the history menu; do not also navigate back/forward.
        if (longPressed.current) {
          longPressed.current = false
          return
        }
        onClick()
      }}
      onContextMenu={(event) => {
        if (!onContextMenu) return
        event.preventDefault()
        cancelLongPress()
        onContextMenu()
      }}
      onPointerDown={() => {
        if (disabled || !onLongPress) return
        cancelLongPress()
        longPressed.current = false
        timer.current = window.setTimeout(() => {
          timer.current = null
          longPressed.current = true
          onLongPress()
        }, 550)
      }}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[color:var(--color-muted)] transition-colors',
        disabled
          ? 'cursor-default opacity-35'
          : 'hover:bg-white/5 hover:text-[#e7e9ef] active:bg-white/10'
      )}
    >
      {children}
    </button>
  )
}
