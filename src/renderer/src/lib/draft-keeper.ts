import type { PublishDraftKind } from '@shared/publish-drafts'

/** Long enough to group keystrokes, short enough that a crash loses next to nothing. */
const DELAY_MS = 250

export interface DraftKeeper {
  load: () => Promise<unknown>
  /** Keep this version, shortly. Pass `null` to forget the draft, at once. */
  save: (value: unknown) => void
}

export function createDraftKeeper(kind: PublishDraftKind): DraftKeeper {
  let waiting: { value: unknown } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let watching = false

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!waiting) return
    const { value } = waiting
    waiting = null
    // Keeping a draft is a safety net: failing to must not get in the user's way.
    void window.ncc.publishDraftSave(kind, value).catch((error: unknown) => {
      console.warn('Could not keep the publishing draft', error)
    })
  }

  return {
    load: async () => {
      try {
        return await window.ncc.publishDraftLoad(kind)
      } catch {
        return null
      }
    },
    save: (value) => {
      if (!watching && typeof window.addEventListener === 'function') {
        watching = true
        window.addEventListener('pagehide', flush)
      }
      waiting = { value }
      if (value === null) return flush()
      timer ??= setTimeout(flush, DELAY_MS)
    }
  }
}
