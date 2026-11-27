/** What the tab strip and the sidebar share, so a tab behaves the same in both. */
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { EyeOff, Volume2, VolumeX, X } from 'lucide-react'
import type { TabSummary } from '@shared/types'
import { cn } from '../lib/cn'
import { TAB_KIND_LABEL } from '../lib/tab-kind'
import { OnionIcon } from './TransportIcons'

export interface TabActions {
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, toIndex: number) => void
  onDetach: (id: string, screenX: number, screenY: number) => void
  onContextMenu: (id: string) => void
  onToggleMute: (id: string) => void
}

/**
 * Drag to reorder along one axis; a tab dropped outside the window is detached.
 * `containerProps` go on the list, `tabProps` on each tab in it.
 */
export function useTabDrag(
  axis: 'x' | 'y',
  { onSelect, onClose, onMove, onDetach, onContextMenu }: TabActions
) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const reset = (): void => {
    setDragId(null)
    setDropIndex(null)
  }

  const containerProps = {
    onDragOver: (event: DragEvent) => event.preventDefault(),
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      const id = dragId ?? event.dataTransfer.getData('text/plain')
      if (id && dropIndex !== null) onMove(id, dropIndex)
      reset()
    }
  }

  const tabProps = (tab: TabSummary, index: number, active: boolean) => ({
    role: 'tab',
    'data-tab-id': tab.id,
    'data-tab-kind': tab.kind,
    'data-no-drag': true,
    'aria-selected': active,
    'aria-label': tab.kind === 'normal' ? undefined : `${tab.title} — ${TAB_KIND_LABEL[tab.kind]}`,
    tabIndex: 0,
    draggable: true,
    title: tab.url || tab.title,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', tab.id)
      setDragId(tab.id)
    },
    onDragEnd: (event: DragEvent) => {
      const outsideWindow =
        event.screenX < window.screenX || event.screenX > window.screenX + window.outerWidth ||
        event.screenY < window.screenY || event.screenY > window.screenY + window.outerHeight
      if (outsideWindow) onDetach(tab.id, event.screenX, event.screenY)
      reset()
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      const before =
        axis === 'x'
          ? event.clientX < rect.left + rect.width / 2
          : event.clientY < rect.top + rect.height / 2
      setDropIndex(before ? index : index + 1)
    },
    onMouseDown: (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault()
        onClose(tab.id)
      }
    },
    onClick: () => onSelect(tab.id),
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault()
      onContextMenu(tab.id)
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect(tab.id)
      }
    }
  })

  return { dragId, dropIndex, containerProps, tabProps }
}

export function TabIcon({ tab }: { tab: TabSummary }) {
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

export function TabKindIcon({
  kind,
  size = 'h-3.5 w-3.5'
}: {
  kind: TabSummary['kind']
  size?: string
}) {
  if (kind === 'private') return <EyeOff className={cn('shrink-0', size)} aria-hidden />
  if (kind === 'tor') return <OnionIcon className={cn('shrink-0', size)} />
  return null
}

export function MuteButton({
  tab,
  onToggleMute
}: {
  tab: TabSummary
  onToggleMute: (id: string) => void
}) {
  if (!tab.audible && !tab.muted) return null
  return (
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
      {tab.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
    </button>
  )
}

export function CloseTabButton({
  tab,
  onClose
}: {
  tab: TabSummary
  onClose: (id: string) => void
}) {
  return (
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
  )
}
