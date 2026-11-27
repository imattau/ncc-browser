import { Check } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn'

/** Where the user is in a guided flow. `current` counts from 0. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol data-stepper aria-label="Progress" className="flex items-center gap-1.5">
      {steps.map((label, index) => {
        const done = index < current
        const active = index === current
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={cn('flex min-w-0 items-center gap-1.5', index < steps.length - 1 && 'flex-1')}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-ui-95 font-semibold',
                done || active
                  ? 'border-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-faint)]',
                active && 'bg-[color:var(--color-accent)] text-[color:var(--color-on-accent)]',
                done && 'text-[color:var(--color-accent)]'
              )}
            >
              {done ? <Check className="h-3 w-3" /> : index + 1}
            </span>
            <span
              className={cn(
                'truncate text-ui-105',
                active
                  ? 'font-semibold text-[color:var(--color-text-strong)]'
                  : 'text-[color:var(--color-muted)]'
              )}
            >
              {label}
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
            {index < steps.length - 1 ? (
              <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-[color:var(--color-line)]" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The title of one step. It takes focus when the step changes, so keyboard and
 * screen reader users are told where they are.
 */
export function StepHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [title])
  return (
    <div>
      <h4
        ref={ref}
        tabIndex={-1}
        className="text-ui-13 font-semibold text-[color:var(--color-text-strong)] outline-none"
      >
        {title}
      </h4>
      {children ? (
        <p className="mt-0.5 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">{children}</p>
      ) : null}
    </div>
  )
}
