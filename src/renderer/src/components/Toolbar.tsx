import { AlertTriangle, ArrowLeft, ArrowRight, RotateCw, Settings, X } from 'lucide-react'
import type { NavState } from '@shared/types'
import { AddressBar } from './AddressBar'
import { SecurityBadge } from './SecurityBadge'
import { cn } from '../lib/cn'

interface ToolbarProps {
  state: NavState
  hint: string | null
  onNavigate: (input: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onOpenSettings: () => void
}

export function Toolbar({
  state,
  hint,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenSettings
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

      <NavButton label="Relays & settings" onClick={onOpenSettings}>
        <Settings className="h-4 w-4" />
      </NavButton>
    </header>
  )
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
