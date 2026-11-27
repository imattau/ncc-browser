import { useEffect, useRef, useState } from 'react'
import {
  Bookmark as BookmarkIcon,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
  Plus,
  Search
} from 'lucide-react'
import type { Bookmark, TabSummary } from '@shared/types'
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from '@shared/layout'
import { cn } from '../lib/cn'
import { bookmarkProps, type BookmarkActions } from '../lib/open-bookmark'
import { TAB_KIND_TONE } from '../lib/tab-kind'
import { CloseTabButton, MuteButton, TabIcon, TabKindIcon, useTabDrag, type TabActions } from './TabParts'

interface SidebarProps extends TabActions {
  tabs: TabSummary[]
  activeTabId: string | null
  collapsed: boolean
  showBookmarks: boolean
  bookmarks: Bookmark[]
  bookmarkActions: BookmarkActions
  onBookmarkList: () => void
  onNew: () => void
  onNewMenu: () => void
  onToggleCollapsed: () => void
  onToggleBookmarks: () => void
  onMoveTabsToTop: () => void
}

/** Beyond this many bookmarks the list gets a search box. */
const SEARCH_FROM = 8

const iconButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]'

/** Tabs above, bookmarks below, each scrolling on its own. */
export function Sidebar(props: SidebarProps) {
  const {
    tabs,
    activeTabId,
    collapsed,
    showBookmarks,
    bookmarks,
    bookmarkActions,
    onBookmarkList,
    onClose,
    onToggleMute,
    onNew,
    onNewMenu,
    onToggleCollapsed,
    onToggleBookmarks,
    onMoveTabsToTop
  } = props
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const { dragId, dropIndex, containerProps, tabProps } = useTabDrag('y', props)

  useEffect(() => {
    if (!activeTabId) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length, collapsed])

  const searchable = bookmarks.length >= SEARCH_FROM
  const needle = searchable ? query.trim().toLowerCase() : ''
  const matching = needle
    ? bookmarks.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)
      )
    : bookmarks
  const listOpen = showBookmarks && !collapsed

  return (
    <aside
      aria-label="Sidebar"
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
      className="flex min-h-0 shrink-0 flex-col border-r border-[color:var(--color-line)] bg-[color:var(--color-field)]"
    >
      <div
        className={cn('flex shrink-0 items-center gap-1 px-2 py-1.5', collapsed && 'flex-col px-0')}
        onContextMenu={(event) => {
          event.preventDefault()
          onNewMenu()
        }}
      >
        <button
          type="button"
          aria-label="New tab (Ctrl+T)"
          title="New tab (Ctrl+T) — right-click for private and Tor tabs"
          onClick={onNew}
          className={cn(
            iconButton,
            !collapsed && 'w-auto min-w-0 flex-1 justify-start gap-2 px-2 text-ui-12'
          )}
        >
          <Plus className="h-4 w-4 shrink-0" />
          {collapsed ? null : <span className="truncate">New tab</span>}
        </button>
        {collapsed ? null : (
          <button
            type="button"
            data-new-tab-menu
            aria-label="New private or Tor tab"
            aria-haspopup="menu"
            title="New private or Tor tab"
            onClick={onNewMenu}
            className={cn(iconButton, 'w-5')}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        role="tablist"
        aria-label="Open tabs"
        aria-orientation="vertical"
        className="flex min-h-[72px] flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5"
        {...containerProps}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId
          const tone = tab.kind === 'normal' ? null : TAB_KIND_TONE[tab.kind]
          return (
            <div
              key={tab.id}
              {...tabProps(tab, index, active)}
              className={cn(
                'group relative flex h-[32px] shrink-0 cursor-default items-center gap-2 rounded-lg border text-ui-12 transition-colors',
                collapsed ? 'justify-center px-0' : 'px-2',
                active
                  ? 'border-[color:var(--color-line)] bg-[color:var(--color-panel)] text-[color:var(--color-text-strong)]'
                  : 'border-transparent text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]',
                tone &&
                  (active
                    ? cn(tone.border, tone.soft, tone.text)
                    : cn(tone.text, 'opacity-80', tone.hover)),
                // In the icon strip the outline is what still marks a private or Tor tab.
                tone && collapsed && tone.border,
                dragId === tab.id && 'opacity-50'
              )}
            >
              {dragId && dropIndex === index ? (
                <span className="absolute -top-[3px] left-1 right-1 h-0.5 rounded bg-[color:var(--color-accent)]" />
              ) : null}

              {collapsed ? (
                <>
                  <RailIcon tab={tab} />
                  <span className="sr-only">{tab.title}</span>
                  {tab.kind === 'normal' ? null : (
                    <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[color:var(--color-field)] p-px">
                      <TabKindIcon kind={tab.kind} size="h-2.5 w-2.5" />
                    </span>
                  )}
                </>
              ) : (
                <>
                  <TabIcon tab={tab} />
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  <TabKindIcon kind={tab.kind} />
                  <MuteButton tab={tab} onToggleMute={onToggleMute} />
                  <CloseTabButton tab={tab} onClose={onClose} />
                </>
              )}
            </div>
          )
        })}
        {dragId && dropIndex === tabs.length ? (
          <span className="mx-1 h-0.5 shrink-0 rounded bg-[color:var(--color-accent)]" />
        ) : null}
      </div>

      {collapsed ? null : (
        <section
          aria-label="Bookmarks"
          data-sidebar-bookmarks
          className={cn(
            'flex flex-col border-t border-[color:var(--color-line)]',
            listOpen ? 'max-h-[48%] min-h-[96px] shrink' : 'shrink-0'
          )}
        >
          <button
            type="button"
            aria-expanded={listOpen}
            title="Show or hide bookmarks (Ctrl+Shift+B)"
            onClick={onToggleBookmarks}
            className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-ui-95 font-semibold uppercase tracking-[0.08em] text-[color:var(--color-faint)] hover:text-[color:var(--color-text-strong)]"
          >
            {listOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Bookmarks
            {bookmarks.length > 0 ? <span className="ml-auto">{bookmarks.length}</span> : null}
          </button>

          {listOpen && searchable ? (
            <div className="relative mx-2 mb-1 shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[color:var(--color-faint)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setQuery('')
                }}
                placeholder="Search bookmarks"
                aria-label="Search bookmarks"
                spellCheck={false}
                className="h-7 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] pl-7 pr-2 text-ui-115 text-[color:var(--color-text)] outline-none placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)]/60"
              />
            </div>
          ) : null}

          {listOpen ? (
            <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
              {bookmarks.length === 0 ? (
                <li className="px-2 py-1 text-ui-11 leading-relaxed text-[color:var(--color-faint)]">
                  No bookmarks yet. Use the star in the address bar, or press Ctrl+D.
                </li>
              ) : matching.length === 0 ? (
                <li className="px-2 py-1 text-ui-11 text-[color:var(--color-faint)]">
                  No bookmark matches “{query.trim()}”.
                </li>
              ) : null}
              {matching.map((bookmark) => (
                <li key={bookmark.url} className="group flex items-center gap-1">
                  <button
                    type="button"
                    title={`${bookmark.title}\n${bookmark.url}`}
                    {...bookmarkProps(bookmark.url, bookmarkActions)}
                    className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-ui-115 text-[color:var(--color-text-soft)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
                  >
                    <BookmarkIcon className="h-3 w-3 shrink-0 text-[color:var(--color-warn)]" />
                    <span className="truncate">{bookmark.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Bookmark options for ${bookmark.title}`}
                    aria-haspopup="menu"
                    title="Bookmark options"
                    onClick={() => bookmarkActions.onContextMenu(bookmark.url)}
                    className="shrink-0 rounded px-1 text-ui-12 leading-none text-[color:var(--color-muted)] opacity-0 hover:bg-[color:var(--color-hover-strong)] focus:opacity-100 group-hover:opacity-100"
                  >
                    ⋯
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

      <div
        className={cn(
          'flex shrink-0 items-center gap-1 border-t border-[color:var(--color-line)] px-2 py-1.5',
          collapsed && 'flex-col px-0'
        )}
      >
        {collapsed ? (
          <button
            type="button"
            aria-label="Bookmarks"
            aria-haspopup="menu"
            title="Bookmarks"
            data-sidebar-bookmark-menu
            onClick={onBookmarkList}
            className={iconButton}
          >
            <BookmarkIcon className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Shrink sidebar to icons'}
          title={collapsed ? 'Expand sidebar' : 'Shrink sidebar to icons'}
          data-sidebar-collapse
          onClick={onToggleCollapsed}
          className={iconButton}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
        <button
          type="button"
          aria-label="Move tabs to the top"
          title="Move tabs to the top"
          data-tabs-to-top
          onClick={onMoveTabsToTop}
          className={cn(iconButton, !collapsed && 'ml-auto')}
        >
          <PanelTop className="h-4 w-4" />
        </button>
      </div>
    </aside>
  )
}

/** With no title on show, a letter tells pages without an icon apart. */
function RailIcon({ tab }: { tab: TabSummary }) {
  if (tab.loading || tab.favicon) return <TabIcon tab={tab} />
  const letter = [...tab.title.trim()][0] ?? '•'
  return (
    <span aria-hidden className="text-ui-12 font-semibold uppercase">
      {letter}
    </span>
  )
}
