import { describe, expect, it } from 'vitest'
import {
  BOOKMARKS_BAR_HEIGHT,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_WIDTH,
  TAB_STRIP_HEIGHT,
  TOOLBAR_HEIGHT,
  chromeInsets,
  toggleBookmarksPatch
} from '../src/shared/layout'
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../src/shared/types'

const layout = (patch: object) => ({ ...DEFAULT_APPEARANCE, ...patch })

describe('layout settings', () => {
  it('leaves a config from an earlier version with tabs on top and no toolbar', () => {
    expect(normalizeAppearance({ theme: 'light' })).toMatchObject({
      tabLayout: 'horizontal',
      bookmarksBar: false,
      sidebarCollapsed: false,
      sidebarBookmarks: true
    })
  })

  it('keeps chosen values and drops invalid ones', () => {
    expect(
      normalizeAppearance({
        tabLayout: 'vertical',
        bookmarksBar: true,
        sidebarCollapsed: true,
        sidebarBookmarks: false
      })
    ).toMatchObject({
      tabLayout: 'vertical',
      bookmarksBar: true,
      sidebarCollapsed: true,
      sidebarBookmarks: false
    })
    expect(normalizeAppearance({ tabLayout: 'diagonal', bookmarksBar: 1 })).toMatchObject({
      tabLayout: 'horizontal',
      bookmarksBar: false
    })
  })
})

describe('chromeInsets', () => {
  it('reserves the tab strip, the toolbar and the optional bookmarks toolbar', () => {
    expect(chromeInsets(layout({}))).toEqual({ top: TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT, left: 0 })
    expect(chromeInsets(layout({ bookmarksBar: true }))).toEqual({
      top: TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT + BOOKMARKS_BAR_HEIGHT,
      left: 0
    })
  })

  it('moves the space to the left with a sidebar, which never has the toolbar', () => {
    expect(chromeInsets(layout({ tabLayout: 'vertical', bookmarksBar: true }))).toEqual({
      top: TOOLBAR_HEIGHT,
      left: SIDEBAR_WIDTH
    })
    expect(chromeInsets(layout({ tabLayout: 'vertical', sidebarCollapsed: true }))).toEqual({
      top: TOOLBAR_HEIGHT,
      left: SIDEBAR_COLLAPSED_WIDTH
    })
  })
})

describe('show or hide bookmarks', () => {
  it('toggles the toolbar with tabs on top', () => {
    expect(toggleBookmarksPatch(layout({}))).toEqual({ bookmarksBar: true })
    expect(toggleBookmarksPatch(layout({ bookmarksBar: true }))).toEqual({ bookmarksBar: false })
  })

  it('toggles the list in the sidebar', () => {
    expect(toggleBookmarksPatch(layout({ tabLayout: 'vertical' }))).toEqual({
      sidebarBookmarks: false
    })
  })

  it('opens a shrunken sidebar on the bookmarks', () => {
    expect(
      toggleBookmarksPatch(layout({ tabLayout: 'vertical', sidebarCollapsed: true }))
    ).toEqual({ sidebarCollapsed: false, sidebarBookmarks: true })
  })
})
