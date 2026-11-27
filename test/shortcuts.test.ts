import { describe, expect, it } from 'vitest'
import type { Input } from 'electron'
import { commandForInput } from '../src/main/shortcuts'

function input(overrides: Partial<Input>): Input {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    isAutoRepeat: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...overrides
  } as Input
}

describe('commandForInput', () => {
  it('maps tab commands', () => {
    expect(commandForInput(input({ key: 't', control: true }))).toBe('new-tab')
    expect(commandForInput(input({ key: 'w', control: true }))).toBe('close-tab')
    expect(commandForInput(input({ key: 'Tab', control: true }))).toBe('next-tab')
    expect(commandForInput(input({ key: 'Tab', control: true, shift: true }))).toBe('previous-tab')
  })

  it('maps navigation commands', () => {
    expect(commandForInput(input({ key: 'l', control: true }))).toBe('focus-address')
    expect(commandForInput(input({ key: 'r', control: true }))).toBe('reload')
    expect(commandForInput(input({ key: 'r', control: true, shift: true }))).toBe('force-reload')
    expect(commandForInput(input({ key: '.', control: true }))).toBe('stop')
    expect(commandForInput(input({ key: 'ArrowLeft', alt: true }))).toBe('back')
    expect(commandForInput(input({ key: 'ArrowRight', alt: true }))).toBe('forward')
  })

  it('maps zoom and developer commands', () => {
    expect(commandForInput(input({ key: '=', control: true }))).toBe('zoom-in')
    expect(commandForInput(input({ key: '+', control: true, shift: true }))).toBe('zoom-in')
    expect(commandForInput(input({ key: '-', control: true }))).toBe('zoom-out')
    expect(commandForInput(input({ key: '0', control: true }))).toBe('zoom-reset')
    expect(commandForInput(input({ key: 'I', control: true, shift: true }))).toBe(
      'toggle-page-devtools'
    )
    expect(commandForInput(input({ key: 'J', control: true, shift: true }))).toBe(
      'toggle-browser-devtools'
    )
    expect(commandForInput(input({ key: 'q', control: true }))).toBe('quit')
    expect(commandForInput(input({ key: 'd', control: true }))).toBe('toggle-bookmark')
    expect(commandForInput(input({ key: 'B', control: true, shift: true }))).toBe('toggle-bookmarks-view')
    expect(commandForInput(input({ key: 'h', control: true }))).toBe('open-history')
    expect(commandForInput(input({ key: 'j', control: true }))).toBe('open-downloads')
  })

  it('supports Command on macOS', () => {
    expect(commandForInput(input({ key: 't', meta: true }))).toBe('new-tab')
    expect(commandForInput(input({ key: 'w', meta: true }))).toBe('close-tab')
    expect(commandForInput(input({ key: 'l', meta: true }))).toBe('focus-address')
  })

  it('ignores key releases, auto-repeat and plain keys', () => {
    expect(commandForInput(input({ key: 't', control: true, type: 'keyUp' }))).toBeNull()
    expect(
      commandForInput(input({ key: 't', control: true, isAutoRepeat: true }))
    ).toBeNull()
    expect(commandForInput(input({ key: 't' }))).toBeNull()
    expect(commandForInput(input({ key: 'Escape' }))).toBeNull()
  })

  it('does not treat modified combinations as navigation', () => {
    expect(commandForInput(input({ key: 'ArrowLeft', alt: true, control: true }))).toBeNull()
    expect(commandForInput(input({ key: 'ArrowLeft' }))).toBeNull()
    expect(commandForInput(input({ key: 't', control: true, alt: true }))).toBeNull()
  })
})
