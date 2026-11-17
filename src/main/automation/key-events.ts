/** Translate a key press into the Electron input events that reproduce it faithfully. */

export interface KeyEvent {
  type: 'keyDown' | 'char' | 'keyUp'
  keyCode: string
}

const KEY_CODES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

/** Keys that also produce text. Chromium only triggers implicit form submission, text
 *  entry and button activation from the `char` event, so a bare keyDown/keyUp is not enough. */
const CHARACTERS: Record<string, string> = { Enter: '\r', Space: ' ' }

export function keyEvents(key: string, modifiers: string[]): KeyEvent[] {
  const keyCode = KEY_CODES[key.toLowerCase()] ?? key
  const shortcut = modifiers.some((entry) => /^(ctrl|control|meta|cmd)$/i.test(entry))
  const text = keyCode.length === 1 ? keyCode : CHARACTERS[keyCode]
  const events: KeyEvent[] = [{ type: 'keyDown', keyCode }]
  if (text && !shortcut) events.push({ type: 'char', keyCode: text })
  events.push({ type: 'keyUp', keyCode })
  return events
}
