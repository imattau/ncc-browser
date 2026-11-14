import { History, Trash2 } from 'lucide-react'
import type { TabHistory } from '@shared/types'
import { cn } from '../lib/cn'
import { Popover } from './Popover'

interface HistoryPanelProps {
  history: TabHistory | null
  onClose: () => void
  onSelect: (index: number) => void
  onClear: () => void
}

export function HistoryPanel({ history, onClose, onSelect, onClear }: HistoryPanelProps) {
  const entries = history?.entries ?? []

  return (
    <Popover
      title="History of this tab"
      subtitle={entries.length > 0 ? `${entries.length} entries` : 'No pages yet'}
      testId="history"
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={entries.length === 0}
          onClick={onClear}
          className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)] disabled:cursor-default disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" />
          Clear history for this tab
        </button>
      }
    >
      {entries.length === 0 ? (
        <div className="px-3 py-8 text-center">
          <History className="mx-auto h-5 w-5 text-[#4d5462]" />
          <p className="mt-2 text-[11.5px] text-[color:var(--color-muted)]">
            Navigation in this tab will be listed here.
          </p>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {[...entries].reverse().map((entry) => {
            const active = entry.index === history?.activeIndex
            return (
              <li key={`${entry.index}:${entry.url}`}>
                <button
                  type="button"
                  data-history-index={entry.index}
                  onClick={() => onSelect(entry.index)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left',
                    active
                      ? 'bg-[color:var(--color-accent)]/10 text-[#e7e9ef]'
                      : 'text-[#c9d1e0] hover:bg-white/[0.05]'
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      active ? 'bg-[color:var(--color-accent)]' : 'bg-[#3f4553]'
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px]">{entry.title}</span>
                    <span className="mt-0.5 block truncate font-mono text-[9.5px] text-[#5d6575]">
                      {entry.url}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Popover>
  )
}
