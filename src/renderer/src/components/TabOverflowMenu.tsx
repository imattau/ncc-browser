import { useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import type { TabSummary } from '@shared/types'
import { cn } from '../lib/cn'
import { Popover } from './Popover'

interface TabOverflowMenuProps {
  tabs: TabSummary[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  onClose: () => void
}

export function TabOverflowMenu({
  tabs,
  activeTabId,
  onSelect,
  onCloseTab,
  onNewTab,
  onClose
}: TabOverflowMenuProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? tabs.filter(
        (tab) =>
          tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
      )
    : tabs

  return (
    <Popover
      title="All tabs"
      subtitle={`${tabs.length} open`}
      topClass="top-[42px]"
      widthClass="w-[380px]"
      testId="tabs"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onNewTab}
          className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted)] hover:text-white"
        >
          <Plus className="h-3 w-3" />
          New tab
        </button>
      }
    >
      <div className="relative mx-1 mb-1.5">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#4d5462]" />
        <input
          data-autofocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tabs"
          spellCheck={false}
          aria-label="Search tabs"
          className="h-8 w-full rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] pl-7 pr-2 text-[12px] text-[#dfe3ea] outline-none placeholder:text-[#5d6575] focus:border-[color:var(--color-accent)]/60"
        />
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-6 text-center text-[11.5px] text-[color:var(--color-muted)]">
          No tab matches “{query.trim()}”.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {visible.map((tab) => (
            <li key={tab.id} className="flex items-center gap-1">
              <button
                type="button"
                data-overflow-tab={tab.id}
                onClick={() => onSelect(tab.id)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                  tab.id === activeTabId
                    ? 'bg-[color:var(--color-accent)]/10 text-[#e7e9ef]'
                    : 'text-[#c9d1e0] hover:bg-white/[0.05]'
                )}
              >
                <TabIcon tab={tab} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px]">{tab.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9.5px] text-[#5d6575]">
                    {tab.url || 'New tab'}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => onCloseTab(tab.id)}
                className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  )
}

function TabIcon({ tab }: { tab: TabSummary }) {
  if (tab.loading) {
    return (
      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[color:var(--color-accent)]/30 border-t-[color:var(--color-accent)]" />
    )
  }
  if (tab.favicon) {
    return (
      <img
        src={tab.favicon}
        alt=""
        draggable={false}
        className="h-3.5 w-3.5 shrink-0 rounded-[2px] object-contain"
      />
    )
  }
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]/60" />
}
