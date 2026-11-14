import { Download, Plus, X } from 'lucide-react'
import type { DownloadNotice, TabSummary } from '@shared/types'
import { cn } from '../lib/cn'

interface TabStripProps {
  tabs: TabSummary[]
  activeTabId: string | null
  downloads: DownloadNotice[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export function TabStrip({ tabs, activeTabId, downloads, onSelect, onClose, onNew }: TabStripProps) {
  return (
    <nav
      aria-label="Tabs"
      className="relative z-10 flex h-[38px] shrink-0 items-end gap-1 border-b border-[color:var(--color-line)] bg-[#0e1016] px-1.5"
    >
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={0}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.id)
              }
            }}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(tab.id)
            }}
            title={tab.url || tab.title}
            className={cn(
              'group relative flex h-[32px] min-w-[120px] max-w-[230px] cursor-default items-center gap-2 rounded-t-lg border border-b-0 px-3 text-[12px] transition-colors',
              tab.id === activeTabId
                ? 'border-[color:var(--color-line)] bg-[color:var(--color-panel)] text-[#e7e9ef]'
                : 'border-transparent text-[color:var(--color-muted)] hover:bg-white/5'
            )}
          >
            {tab.loading ? (
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[color:var(--color-accent)]/30 border-t-[color:var(--color-accent)]" />
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]/60" />
            )}
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              className="shrink-0 rounded p-0.5 text-[color:var(--color-muted)] opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100 focus:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}

        <button
          type="button"
          aria-label="New tab (Ctrl+T)"
          title="New tab (Ctrl+T)"
          onClick={onNew}
          className="mb-[3px] ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {downloads.length > 0 ? (
        <div className="mb-[3px] flex shrink-0 items-center gap-1">
          {downloads.slice(-2).map((notice) => (
            <span
              key={notice.id}
              title={notice.path ?? notice.filename}
              className={cn(
                'inline-flex max-w-[230px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]',
                notice.state === 'failed'
                  ? 'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
                  : 'border-[color:var(--color-line)] bg-white/[0.03] text-[color:var(--color-muted)]'
              )}
            >
              <Download className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {notice.state === 'started'
                  ? `Downloading ${notice.filename}`
                  : notice.state === 'completed'
                    ? `Saved ${notice.filename}`
                    : notice.state === 'cancelled'
                      ? 'Download cancelled'
                      : 'Download failed'}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </nav>
  )
}
