import { Maximize2, Minus, X } from 'lucide-react'
import { cn } from '../lib/cn'

export interface WindowControlsProps {
  windowMaximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onCloseWindow: () => void
}

/** Minimize, maximize and close for the frameless window. */
export function WindowControls({
  windowMaximized,
  onMinimize,
  onToggleMaximize,
  onCloseWindow
}: WindowControlsProps) {
  return (
    <>
      <WindowButton label="Minimize" onClick={onMinimize}>
        <Minus className="h-3.5 w-3.5" />
      </WindowButton>
      <WindowButton
        label={windowMaximized ? 'Restore window' : 'Maximize window'}
        onClick={onToggleMaximize}
      >
        <Maximize2 className="h-3 w-3" />
      </WindowButton>
      <WindowButton label="Close window" danger onClick={onCloseWindow}>
        <X className="h-3.5 w-3.5" />
      </WindowButton>
    </>
  )
}

interface WindowButtonProps {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}

function WindowButton({ label, danger, onClick, children }: WindowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-7 items-center justify-center rounded text-[color:var(--color-muted)] transition-colors',
        danger
          ? 'hover:bg-[color:var(--color-danger-solid)] hover:text-[color:var(--color-on-danger)]'
          : 'hover:bg-[color:var(--color-hover-strong)] hover:text-[color:var(--color-text-strong)]'
      )}
    >
      {children}
    </button>
  )
}
