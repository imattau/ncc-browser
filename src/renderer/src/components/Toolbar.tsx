import { AlertTriangle, ArrowLeft, ArrowRight, KeyRound, Menu, RotateCw, X } from 'lucide-react'
import type { IdentityStatus, NavState } from '@shared/types'
import { AddressBar } from './AddressBar'
import { SecurityBadge } from './SecurityBadge'
import { cn } from '../lib/cn'

interface ToolbarProps {
  state: NavState
  hint: string | null
  identity: IdentityStatus | null
  signerPending: boolean
  onNavigate: (input: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onOpenSettings: () => void
  onOpenMenu: () => void
}

export function Toolbar({
  state,
  hint,
  identity,
  signerPending,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenSettings,
  onOpenMenu
}: ToolbarProps) {
  const showFailure = state.failure && state.failure.code !== 'invalid-address'

  return (
    <header className="relative z-10 flex h-[60px] shrink-0 items-center gap-2 border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-3">
      <NavButton label="Back (Alt+←)" disabled={!state.canGoBack} onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
      </NavButton>
      <NavButton label="Forward (Alt+→)" disabled={!state.canGoForward} onClick={onForward}>
        <ArrowRight className="h-4 w-4" />
      </NavButton>
      <NavButton
        label={state.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)'}
        onClick={state.loading ? onStop : onReload}
        disabled={state.mode === 'blank'}
      >
        {state.loading ? <X className="h-4 w-4" /> : <RotateCw className="h-3.5 w-3.5" />}
      </NavButton>

      <AddressBar
        value={state.displayUrl}
        loading={state.loading}
        hint={hint}
        onNavigate={onNavigate}
      />

      {showFailure ? (
        <button
          type="button"
          onClick={onReload}
          title={`${state.failure?.code}: ${state.failure?.message}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 px-2 text-[11px] font-medium text-[color:var(--color-danger)]"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {state.failure?.code}
        </button>
      ) : null}

      <SecurityBadge state={state} />

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
  children: React.ReactNode
}

function NavButton({ label, disabled, onClick, children }: NavButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
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
