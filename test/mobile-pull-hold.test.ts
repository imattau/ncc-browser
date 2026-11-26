import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JavaScript module from the mobile shell
import { createPullHold } from '../mobile/pull-hold.js'

describe('tab switcher pull and hold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('refreshes after pulling, holding and letting go', () => {
    const armed = vi.fn()
    const pull = createPullHold({ onArmed: armed })
    expect(pull.move(60)).toBe('pull')
    expect(pull.move(130)).toBe('hold')
    vi.advanceTimersByTime(350)
    expect(armed).toHaveBeenCalledWith(130)
    expect(pull.move(132)).toBe('ready')
    expect(pull.release()).toBe(true)
  })

  it('does nothing for a flick', () => {
    const armed = vi.fn()
    const pull = createPullHold({ onArmed: armed })
    pull.move(300)
    vi.advanceTimersByTime(100)
    expect(pull.release()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(armed).not.toHaveBeenCalled()
  })

  it('is taken back by sliding up, and can be armed again', () => {
    const pull = createPullHold()
    pull.move(130)
    vi.advanceTimersByTime(400)
    expect(pull.move(90)).toBe('ready')
    expect(pull.move(70)).toBe('cancel')
    vi.advanceTimersByTime(1000)
    expect(pull.release()).toBe(false)

    pull.move(130)
    vi.advanceTimersByTime(400)
    expect(pull.release()).toBe(true)
  })

  it('forgets a hold that is abandoned', () => {
    const armed = vi.fn()
    const pull = createPullHold({ onArmed: armed })
    pull.move(130)
    pull.reset()
    vi.advanceTimersByTime(1000)
    expect(armed).not.toHaveBeenCalled()
    expect(pull.move(40)).toBe('pull')
  })
})
