import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronsDown, Plus } from 'lucide-react'
import type { TabSummary } from '@shared/types'
import { cn } from '../lib/cn'
import { TAB_KIND_TONE } from '../lib/tab-kind'
import { CloseTabButton, MuteButton, TabIcon, TabKindIcon, useTabDrag, type TabActions } from './TabParts'
import { WindowControls, type WindowControlsProps } from './WindowControls'

interface TabStripProps extends TabActions, WindowControlsProps {
  tabs: TabSummary[]
  activeTabId: string | null
  onNew: () => void
  onNewMenu: () => void
  onOverflow: () => void
}

const isMac = navigator.platform.toLowerCase().includes('mac')

export function TabStrip(props: TabStripProps) {
  const {
    tabs,
    activeTabId,
    windowMaximized,
    onClose,
    onNew,
    onNewMenu,
    onToggleMute,
    onOverflow,
    onMinimize,
    onToggleMaximize,
    onCloseWindow
  } = props
  const stripRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const { dragId, dropIndex, containerProps, tabProps } = useTabDrag('x', props)

  useEffect(() => {
    const element = stripRef.current
    if (!element) return
    const update = (): void => setOverflow(element.scrollWidth > element.clientWidth + 2)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [tabs.length])

  useEffect(() => {
    if (!activeTabId) return
    const element = stripRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${activeTabId}"]`
    )
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  const onTitlebarDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (isMac) return
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    onToggleMaximize()
  }

  return (
    <nav
      aria-label="Tabs"
      data-titlebar
      className="ncc-drag relative z-10 flex h-[38px] shrink-0 items-end gap-1 border-b border-[color:var(--color-line)] bg-[color:var(--color-field)] px-1.5"
      onDoubleClick={onTitlebarDoubleClick}
      {...containerProps}
    >
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open tabs"
        className="ncc-drag flex min-w-0 flex-1 items-end gap-1 overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              {...tabProps(tab, index, active)}
              className={cn(
                'ncc-no-drag group relative flex h-[32px] min-w-[120px] max-w-[230px] cursor-default items-center gap-2 rounded-t-lg border border-b-0 px-3 text-ui-12 transition-colors',
                active
                  ? 'border-[color:var(--color-line)] bg-[color:var(--color-panel)] text-[color:var(--color-text-strong)]'
                  : 'border-transparent text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]',
                tab.kind !== 'normal' &&
                  (active
                    ? cn(TAB_KIND_TONE[tab.kind].border, TAB_KIND_TONE[tab.kind].soft, TAB_KIND_TONE[tab.kind].text)
                    : cn(TAB_KIND_TONE[tab.kind].text, 'opacity-80', TAB_KIND_TONE[tab.kind].hover)),
                dragId === tab.id && 'opacity-50'
              )}
            >
              {dragId && dropIndex === index ? (
                <span className="absolute -left-1 top-1 bottom-1 w-0.5 rounded bg-[color:var(--color-accent)]" />
              ) : null}

              <TabIcon tab={tab} />

              <span className="min-w-0 flex-1 truncate">{tab.title}</span>

              <TabKindIcon kind={tab.kind} />
              <MuteButton tab={tab} onToggleMute={onToggleMute} />
              <CloseTabButton tab={tab} onClose={onClose} />
            </div>
          )
        })}

        {dragId && dropIndex === tabs.length ? (
          <span className="mb-1 h-[26px] w-0.5 shrink-0 rounded bg-[color:var(--color-accent)]" />
        ) : null}

        <div
          data-no-drag
          className="ncc-no-drag mb-[3px] ml-0.5 inline-flex shrink-0 items-center rounded-lg"
          onContextMenu={(event) => {
            event.preventDefault()
            onNewMenu()
          }}
        >
          <button
            type="button"
            data-no-drag
            aria-label="New tab (Ctrl+T)"
            title="New tab (Ctrl+T) — right-click for private and Tor tabs"
            onClick={onNew}
            className="ncc-no-drag inline-flex h-7 w-7 items-center justify-center rounded-l-lg text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-no-drag
            data-new-tab-menu
            aria-label="New private or Tor tab"
            aria-haspopup="menu"
            title="New private or Tor tab"
            onClick={onNewMenu}
            className="ncc-no-drag inline-flex h-7 w-4 items-center justify-center rounded-r-lg text-[color:var(--color-faint)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>

      {overflow ? (
        <button
          type="button"
          data-no-drag
          aria-label="All tabs"
          title="All tabs"
          onClick={onOverflow}
          className="ncc-no-drag mb-[4px] inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          <ChevronsDown className="h-4 w-4" />
        </button>
      ) : null}

      <div
        data-no-drag
        className="ncc-no-drag mb-[3px] ml-1 flex shrink-0 items-center gap-0.5 self-center"
      >
        <WindowControls
          windowMaximized={windowMaximized}
          onMinimize={onMinimize}
          onToggleMaximize={onToggleMaximize}
          onCloseWindow={onCloseWindow}
        />
      </div>
    </nav>
  )
}
