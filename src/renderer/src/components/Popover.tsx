import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useFocusTrap } from '../lib/useFocusTrap'

interface PopoverProps {
  title: string
  subtitle?: string
  /** Tailwind top offset, below the tab strip or the toolbar. */
  topClass?: string
  widthClass?: string
  testId: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

/**
 * Full-window scrim plus a card, so a popover can extend over the content area.
 * Content views are hidden by the shell while one is open.
 */
export function Popover({
  title,
  subtitle,
  topClass = 'top-[104px]',
  widthClass = 'w-[340px]',
  testId,
  onClose,
  footer,
  children
}: PopoverProps) {
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

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/35 backdrop-blur-[1px]"
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-popover={testId}
        className={`ncc-fade-in absolute right-3 ${topClass} ${widthClass} overflow-hidden rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[color:var(--color-line)] px-3.5 py-2.5">
          <div className="min-w-0">
            <h2 className="text-[12px] font-semibold text-[#e7e9ef]">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-[10.5px] text-[color:var(--color-muted)]">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="max-h-[58vh] overflow-y-auto p-1.5">{children}</div>

        {footer ? (
          <div className="border-t border-[color:var(--color-line)] px-3 py-2">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}
