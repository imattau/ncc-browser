import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown,
  ChevronsDown,
  EyeOff,
  Maximize2,
  Minus,
  Plus,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { TabSummary } from '@shared/types'
import { cn } from '../lib/cn'
import { OnionIcon } from './TransportIcons'
import { TAB_KIND_LABEL, TAB_KIND_TONE } from '../lib/tab-kind'

interface TabStripProps {
  tabs: TabSummary[]
  activeTabId: string | null
  windowMaximized: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onNewMenu: () => void
  onMove: (id: string, toIndex: number) => void
  onDetach: (id: string, screenX: number, screenY: number) => void
  onContextMenu: (id: string) => void
  onToggleMute: (id: string) => void
  onOverflow: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onCloseWindow: () => void
}

const isMac = navigator.platform.toLowerCase().includes('mac')

export function TabStrip({
  tabs,
  activeTabId,
  windowMaximized,
  onSelect,
  onClose,
  onNew,
  onNewMenu,
  onMove,
  onDetach,
  onContextMenu,
  onToggleMute,
  onOverflow,
  onMinimize,
  onToggleMaximize,
  onCloseWindow
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

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

  const resetDrag = (): void => {
    setDragId(null)
    setDropIndex(null)
  }

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
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const id = dragId ?? event.dataTransfer.getData('text/plain')
        if (id && dropIndex !== null) onMove(id, dropIndex)
        resetDrag()
      }}
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
              role="tab"
              data-tab-id={tab.id}
              data-tab-kind={tab.kind}
              data-no-drag
              aria-selected={active}
              aria-label={tab.kind === 'normal' ? undefined : `${tab.title} — ${TAB_KIND_LABEL[tab.kind]}`}
              tabIndex={0}
              draggable
              title={tab.url || tab.title}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
                setDragId(tab.id)
              }}
              onDragEnd={(event) => {
                const outsideWindow =
                  event.screenX < window.screenX || event.screenX > window.screenX + window.outerWidth ||
                  event.screenY < window.screenY || event.screenY > window.screenY + window.outerHeight
                if (outsideWindow) onDetach(tab.id, event.screenX, event.screenY)
                resetDrag()
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const rect = event.currentTarget.getBoundingClientRect()
                setDropIndex(event.clientX < rect.left + rect.width / 2 ? index : index + 1)
              }}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  onClose(tab.id)
                }
              }}
              onClick={() => onSelect(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                onContextMenu(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(tab.id)
                }
              }}
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

              {tab.loading ? (
                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[color:var(--color-accent)]/30 border-t-[color:var(--color-accent)]" />
              ) : tab.favicon ? (
                <img
                  src={tab.favicon}
                  alt=""
                  draggable={false}
                  className="h-3.5 w-3.5 shrink-0 rounded-[2px] object-contain"
                />
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]/60" />
              )}

              <span className="min-w-0 flex-1 truncate">{tab.title}</span>

              {tab.kind === 'private' ? (
                <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : tab.kind === 'tor' ? (
                <OnionIcon className="h-3.5 w-3.5 shrink-0" />
              ) : null}

              {tab.audible || tab.muted ? (
                <button
                  type="button"
                  aria-label={tab.muted ? `Unmute ${tab.title}` : `Mute ${tab.title}`}
                  title={tab.muted ? 'Unmute tab' : 'Mute tab'}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleMute(tab.id)
                  }}
                  className={cn(
                    'shrink-0 rounded p-0.5 hover:bg-[color:var(--color-hover-strong)]',
                    tab.muted ? 'text-[color:var(--color-faint)]' : 'text-[color:var(--color-accent)]'
                  )}
                >
                  {tab.muted ? (
                    <VolumeX className="h-3 w-3" />
                  ) : (
                    <Volume2 className="h-3 w-3" />
                  )}
                </button>
              ) : null}

              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.id)
                }}
                className="shrink-0 rounded p-0.5 text-[color:var(--color-muted)] opacity-0 transition-opacity hover:bg-[color:var(--color-hover-strong)] hover:text-[color:var(--color-text-strong)] group-hover:opacity-100 focus:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
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
      </div>
    </nav>
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
