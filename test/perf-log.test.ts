import { describe, expect, it, vi } from 'vitest'
import { createPerfLog } from '../src/main/perf'

describe('timing log', () => {
  it('reports only late timers, and nothing unless enabled', () => {
    vi.useFakeTimers()
    let clock = 0
    const lines: string[] = []
    const stop = createPerfLog(true, () => clock, (line) => lines.push(line)).watchStalls()
    clock = 50
    vi.advanceTimersByTime(50)
    clock = 400
    vi.advanceTimersByTime(50)
    stop()
    expect(lines).toEqual(['[perf] main process stalled 300 ms, ending at 400 ms'])

    const quiet = createPerfLog(false, () => clock, (line) => lines.push(line))
    quiet.mark('app ready')
    quiet.watchStalls()()
    expect(lines).toHaveLength(1)
    vi.useRealTimers()
  })
})
