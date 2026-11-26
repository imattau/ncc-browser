/**
 * The hold step of pull-to-refresh in the tab switcher: pull far enough, stay there,
 * let go. Matches `PullGesture.kt`, which does the same for a page.
 */
export function createPullHold({ triggerAt = 100, slack = 20, holdMs = 350, onArmed = () => {} } = {}) {
  let state = 'pull'
  let wasArmed = false
  let timer = null
  let latest = 0

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const reset = () => {
    stopTimer()
    state = 'pull'
    wasArmed = false
  }

  return {
    reset,
    /** Returns what to show: 'pull', 'hold', 'ready' or 'cancel'. */
    move(distance) {
      latest = distance
      if (state === 'pull') {
        if (distance >= triggerAt) {
          state = 'hold'
          timer = setTimeout(() => {
            timer = null
            state = 'ready'
            wasArmed = true
            onArmed(latest)
          }, holdMs)
        }
      } else if (distance < triggerAt - slack) {
        stopTimer()
        state = 'pull'
      }
      return state === 'pull' && wasArmed ? 'cancel' : state
    },
    /** The finger lifted: true when it should refresh. */
    release() {
      const armed = state === 'ready'
      reset()
      return armed
    }
  }
}
