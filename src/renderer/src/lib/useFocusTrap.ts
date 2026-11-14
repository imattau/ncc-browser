import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keep Tab / Shift+Tab inside a modal or popover while it is open, and restore focus
 * to where it came from when it closes. This is what stops keyboard focus from
 * walking into the chrome behind the signer sheet.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0
      )

    const preferred = container.querySelector<HTMLElement>('[data-autofocus]')
    const first = preferred ?? focusable()[0]
    first?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        return
      }

      const current = document.activeElement
      const index = current instanceof HTMLElement ? items.indexOf(current) : -1

      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          items[items.length - 1].focus()
        }
      } else if (index === -1 || index === items.length - 1) {
        event.preventDefault()
        items[0].focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
  }, [active, containerRef])
}
