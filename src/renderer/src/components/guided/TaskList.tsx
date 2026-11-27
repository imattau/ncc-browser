import { Check, Circle, LoaderCircle, Minus, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { Task, TaskStatus } from './tasks'
import { PROGRESS_BAR } from './ui'

const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: 'waiting',
  running: 'in progress',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped'
}

/** The stages of a running job, each with its own state. */
export function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <ul data-task-list aria-live="polite" className="space-y-2.5">
      {tasks.map((task) => (
        <li key={task.key} data-task={task.key} data-status={task.status} className="flex gap-2.5">
          <span aria-hidden="true" className="mt-0.5 shrink-0">
            {task.status === 'running' ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-[color:var(--color-accent)]" />
            ) : task.status === 'done' ? (
              <Check className="h-4 w-4 text-[color:var(--color-ok)]" />
            ) : task.status === 'failed' ? (
              <X className="h-4 w-4 text-[color:var(--color-danger)]" />
            ) : task.status === 'skipped' ? (
              <Minus className="h-4 w-4 text-[color:var(--color-faint)]" />
            ) : (
              <Circle className="h-4 w-4 text-[color:var(--color-line)]" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex justify-between gap-2 text-ui-12">
              <span
                className={cn(
                  task.status === 'pending' || task.status === 'skipped'
                    ? 'text-[color:var(--color-muted)]'
                    : 'text-[color:var(--color-text-strong)]'
                )}
              >
                {task.label}
                <span className="sr-only">: {STATUS_TEXT[task.status]}</span>
              </span>
              {task.progress ? (
                <span className="shrink-0 tabular-nums text-ui-11 text-[color:var(--color-muted)]">
                  {task.progress.done} of {task.progress.total}
                </span>
              ) : null}
            </div>
            {task.progress && task.status === 'running' ? (
              <progress
                aria-label={task.label}
                className={PROGRESS_BAR}
                value={task.progress.done}
                max={Math.max(1, task.progress.total)}
              />
            ) : null}
            {task.detail ? (
              <p
                className={cn(
                  'mt-0.5 break-words text-ui-105',
                  task.status === 'failed'
                    ? 'text-[color:var(--color-danger)]'
                    : 'text-[color:var(--color-muted)]'
                )}
              >
                {task.detail}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
