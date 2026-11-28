/**
 * Opt-in timing log (`NCC_PERF=1`) for slow startups and a laggy window: startup
 * milestones, and every time the main process was too busy to respond. It records
 * times only, never addresses or page content.
 */

const INTERVAL_MS = 50
const STALL_MS = 100

export function createPerfLog(
  enabled: boolean,
  now: () => number = () => performance.now(),
  write: (line: string) => void = (line) => console.log(line)
): { mark: (label: string) => void; watchStalls: () => () => void } {
  return {
    mark(label) {
      if (enabled) write(`[perf] ${label} at ${Math.round(now())} ms`)
    },
    watchStalls() {
      if (!enabled) return () => {}
      let last = now()
      const timer = setInterval(() => {
        const at = now()
        // A timer that fires late means nothing else could run either.
        const late = at - last - INTERVAL_MS
        last = at
        if (late >= STALL_MS) {
          write(`[perf] main process stalled ${Math.round(late)} ms, ending at ${Math.round(at)} ms`)
        }
      }, INTERVAL_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }
  }
}
