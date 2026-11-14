import type { Input } from 'electron'
import type { CommandId } from '@shared/commands'

/**
 * Map a keyboard event to a browser command. Runs in `before-input-event`, so it works
 * the same whether the chrome UI or a remote page has focus and needs no menu bar.
 */
export function commandForInput(input: Input): CommandId | null {
  if (input.type !== 'keyDown') return null
  if (input.isAutoRepeat) return null

  const key = input.key.toLowerCase()
  const primary = input.control || input.meta

  if (primary && !input.alt) {
    if (key === 't' && !input.shift) return 'new-tab'
    if (key === 'w' && !input.shift) return 'close-tab'
    if (key === 'l' && !input.shift) return 'focus-address'
    if (key === 'r') return input.shift ? 'force-reload' : 'reload'
    if (key === '.' && !input.shift) return 'stop'
    if (key === '0' && !input.shift) return 'zoom-reset'
    if ((key === '=' || key === '+') && !input.shift) return 'zoom-in'
    if (key === '+' && input.shift) return 'zoom-in'
    if ((key === '-' || key === '_') && !input.shift) return 'zoom-out'
    if (key === 'tab') return input.shift ? 'previous-tab' : 'next-tab'
    if (key === 'd' && !input.shift) return 'toggle-bookmark'
    if (key === 'h' && !input.shift) return 'open-history'
    if (key === 'j' && !input.shift) return 'open-downloads'
    if (key === 'i' && input.shift) return 'toggle-page-devtools'
    if (key === 'j' && input.shift) return 'toggle-browser-devtools'
    if (key === 'q' && !input.shift) return 'quit'
  }

  if (input.alt && !primary) {
    if (key === 'arrowleft') return 'back'
    if (key === 'arrowright') return 'forward'
  }

  return null
}
