import { describe, expect, it } from 'vitest'
import {
  describeChromeContextMenu,
  describeContextMenu
} from '../src/main/context-menu-model'

const base = { canGoBack: false, canGoForward: false }

describe('describeContextMenu', () => {
  it('always offers navigation', () => {
    const actions = describeContextMenu(base)
    expect(actions.map((action) => action.id)).toEqual([
      'back',
      'forward',
      'reload',
      'separator',
      'inspect'
    ])
    expect(actions[0].enabled).toBe(false)
    expect(actions[1].enabled).toBe(false)
  })

  it('reflects history availability', () => {
    const actions = describeContextMenu({ canGoBack: true, canGoForward: true })
    expect(actions[0].enabled).toBe(true)
    expect(actions[1].enabled).toBe(true)
  })

  it('adds link actions', () => {
    const actions = describeContextMenu({
      ...base,
      linkURL: 'ncc://npub1abc/web/page'
    })
    expect(actions.slice(0, 2).map((action) => action.id)).toEqual(['open-link', 'copy-link'])
    expect(actions[2].id).toBe('separator')
  })

  it('adds image actions', () => {
    const actions = describeContextMenu({
      ...base,
      mediaType: 'image',
      srcURL: 'ncc://npub1abc/web/logo.png'
    })
    expect(actions.slice(0, 3).map((action) => action.id)).toEqual([
      'open-image',
      'copy-image',
      'save-image'
    ])
  })

  it('adds editing actions for editable fields', () => {
    const actions = describeContextMenu({ ...base, isEditable: true })
    const ids = actions.map((action) => action.id)
    for (const id of ['undo', 'redo', 'cut', 'copy', 'paste', 'select-all']) {
      expect(ids).toContain(id)
    }
  })

  it('adds copy for a text selection', () => {
    const actions = describeContextMenu({ ...base, selectionText: 'hello' })
    expect(actions[0]).toEqual({ id: 'copy', label: 'Copy' })
    expect(actions.some((action) => action.id === 'cut')).toBe(false)
  })

  it('ignores whitespace-only selections', () => {
    const actions = describeContextMenu({ ...base, selectionText: '   ' })
    expect(actions[0].id).toBe('back')
  })

  it('never emits duplicate or trailing separators', () => {
    const actions = describeContextMenu({
      canGoBack: true,
      canGoForward: true,
      linkURL: 'ncc://npub1abc/web/x',
      mediaType: 'image',
      srcURL: 'ncc://npub1abc/web/x.png',
      isEditable: true,
      selectionText: 'text'
    })
    expect(actions[0].id).not.toBe('separator')
    expect(actions[actions.length - 1].id).not.toBe('separator')
    for (let index = 1; index < actions.length; index += 1) {
      expect(
        actions[index].id === 'separator' && actions[index - 1].id === 'separator'
      ).toBe(false)
    }
  })
})

describe('describeChromeContextMenu', () => {
  it('offers editing actions for chrome inputs', () => {
    const actions = describeChromeContextMenu({ isEditable: true })
    expect(actions.map((action) => action.id)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'select-all'
    ])
  })

  it('offers copy for chrome selections and nothing otherwise', () => {
    expect(describeChromeContextMenu({ selectionText: 'x' })).toEqual([
      { id: 'copy', label: 'Copy' }
    ])
    expect(describeChromeContextMenu({})).toEqual([])
  })
})
