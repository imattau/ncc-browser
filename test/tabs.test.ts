import { describe, expect, it } from 'vitest'
import { reorderTabs } from '../src/shared/tabs'

const tabs = ['a', 'b', 'c', 'd'].map((id) => ({ id }))

function ids(list: readonly { id: string }[]): string[] {
  return list.map((tab) => tab.id)
}

describe('reorderTabs', () => {
  it('moves a tab to the right', () => {
    expect(ids(reorderTabs(tabs, 'a', 3))).toEqual(['b', 'c', 'a', 'd'])
    expect(ids(reorderTabs(tabs, 'a', 4))).toEqual(['b', 'c', 'd', 'a'])
  })

  it('moves a tab to the left', () => {
    expect(ids(reorderTabs(tabs, 'd', 0))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(reorderTabs(tabs, 'c', 1))).toEqual(['a', 'c', 'b', 'd'])
  })

  it('is a no-op when dropped in place', () => {
    expect(ids(reorderTabs(tabs, 'b', 1))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(reorderTabs(tabs, 'b', 2))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ignores unknown ids and clamps out-of-range indexes', () => {
    expect(ids(reorderTabs(tabs, 'zzz', 0))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(reorderTabs(tabs, 'a', -5))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(reorderTabs(tabs, 'a', 99))).toEqual(['b', 'c', 'd', 'a'])
  })
})
