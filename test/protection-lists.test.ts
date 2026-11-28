import { Script, createContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  LIST_MAX_AGE_MS,
  cosmeticHideScript,
  isListStale,
  isUsableList
} from '../src/main/protection-lists'

describe('isUsableList', () => {
  it('accepts a list that is only its title comment', () => {
    expect(isUsableList('! Brave desktop filters\n')).toBe(true)
  })

  it('rejects an HTML page, a short error body and an empty response', () => {
    expect(isUsableList(`<!doctype html><p>${'x'.repeat(200)}`)).toBe(false)
    expect(isUsableList('404: Not Found')).toBe(false)
    expect(isUsableList('')).toBe(false)
  })
})

describe('isListStale', () => {
  it('refreshes a missing or day-old list only', () => {
    const now = 10 * LIST_MAX_AGE_MS
    expect(isListStale(null, now)).toBe(true)
    expect(isListStale(now - LIST_MAX_AGE_MS, now)).toBe(true)
    expect(isListStale(now - 1000, now)).toBe(false)
  })
})

describe('cosmeticHideScript', () => {
  it('searches once now and once per burst of page changes', () => {
    vi.useFakeTimers()
    const querySelectorAll = vi.fn(() => [])
    let changed = (): void => {}
    class Observer {
      constructor(callback: () => void) {
        changed = callback
      }
      observe(): void {}
    }
    new Script(cosmeticHideScript(['.ad'])).runInContext(
      createContext({
        document: { documentElement: {}, querySelectorAll },
        MutationObserver: Observer,
        setTimeout
      })
    )
    for (let i = 0; i < 50; i++) changed()
    expect(querySelectorAll).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(querySelectorAll).toHaveBeenCalledTimes(2)
    changed()
    vi.advanceTimersByTime(200)
    expect(querySelectorAll).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
