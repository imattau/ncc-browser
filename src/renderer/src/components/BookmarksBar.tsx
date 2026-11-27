import { useLayoutEffect, useRef, useState } from 'react'
import { Bookmark as BookmarkIcon, ChevronsRight } from 'lucide-react'
import type { Bookmark } from '@shared/types'
import { cn } from '../lib/cn'
import { bookmarkProps, type BookmarkActions } from '../lib/open-bookmark'

interface BookmarksBarProps extends BookmarkActions {
  bookmarks: Bookmark[]
  /** Show the bookmarks from this position on in a menu. */
  onMore: (fromIndex: number) => void
}

/** More than any window is wide enough for; the rest are in the overflow menu. */
const MAX_RENDERED = 60

export function BookmarksBar({ bookmarks, onMore, ...actions }: BookmarksBarProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [fitting, setFitting] = useState(MAX_RENDERED)
  const shown = bookmarks.slice(0, MAX_RENDERED)

  // Only whole bookmarks are shown. Hidden ones keep their space, so measuring
  // again after a resize or a text size change gives the right answer.
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const measure = (): void => {
      const edge = row.getBoundingClientRect().right + 0.5
      const items = [...row.children] as HTMLElement[]
      const first = items.findIndex((item) => item.getBoundingClientRect().right > edge)
      setFitting(first === -1 ? items.length : first)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const child of row.children) observer.observe(child)
    return () => observer.disconnect()
  }, [bookmarks])

  const more = bookmarks.length > fitting

  return (
    <nav
      aria-label="Bookmarks toolbar"
      data-bookmarks-bar
      className="flex h-[34px] shrink-0 items-center gap-1 border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-2"
    >
      {bookmarks.length === 0 ? (
        <p className="truncate px-1 text-ui-11 text-[color:var(--color-faint)]">
          No bookmarks yet. Use the star in the address bar, or press Ctrl+D, to add this page.
        </p>
      ) : null}
      <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {shown.map((bookmark, index) => (
          <button
            key={bookmark.url}
            type="button"
            title={`${bookmark.title}\n${bookmark.url}`}
            {...bookmarkProps(bookmark.url, actions)}
            className={cn(
              'flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-ui-115 text-[color:var(--color-text-soft)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]',
              index >= fitting && 'invisible'
            )}
          >
            <BookmarkIcon className="h-3 w-3 shrink-0 text-[color:var(--color-warn)]" />
            <span className="truncate">{bookmark.title}</span>
          </button>
        ))}
      </div>
      {more ? (
        <button
          type="button"
          aria-label="More bookmarks"
          aria-haspopup="menu"
          title="More bookmarks"
          data-bookmarks-more
          onClick={() => onMore(fitting)}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
      ) : null}
    </nav>
  )
}
