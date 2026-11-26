package io.github.imattau.nccbrowser

import kotlin.math.abs
import kotlin.math.max

/**
 * Pull down, hold, let go: the three steps that reload a page.
 *
 * A flick, or letting go before the hold completes, does nothing, and moving the finger
 * back up after arming takes it back. No Android types, so it can be tested directly.
 * Distances are in pixels and times in milliseconds.
 */
class PullGesture(
  /** Travel ignored while deciding whether this is a pull at all. */
  private val slop: Float,
  /** Travel at which the indicator appears. */
  private val showAt: Float,
  /** Travel at which the hold starts. */
  private val triggerAt: Float,
  /** How far back above [triggerAt] the finger goes before the pull is taken back. */
  private val cancelSlack: Float,
  private val holdMillis: Long = HOLD_MILLIS,
) {
  enum class State {
    /** Not a pull. */
    IDLE,
    /** Started at the top of the page; the page may yet use this drag itself. */
    WATCHING,
    /** The indicator is showing and letting go does nothing. */
    PULLING,
    /** Far enough: waiting for the finger to stay there. */
    HOLDING,
    /** Letting go now reloads. */
    ARMED,
  }

  var state = State.IDLE
    private set

  /** Downward travel of the pull so far. */
  var distance = 0f
    private set

  private var startX = 0f
  private var startY = 0f
  private var holdSince = 0L
  private var unused = false

  /** True once the drag belongs to the pull and no longer to the page. */
  val isEngaged: Boolean
    get() = state == State.PULLING || state == State.HOLDING || state == State.ARMED

  /** How much of the way to the hold the finger has come, from 0 to 1. */
  val pullFraction: Float
    get() = (distance / triggerAt).coerceIn(0f, 1f)

  fun down(x: Float, y: Float, atTop: Boolean) {
    reset()
    if (!atTop) return
    startX = x
    startY = y
    state = State.WATCHING
  }

  /**
   * The page had nowhere to go with a downward drag. A page that scrolls an inner panel,
   * handles the touch itself, or turns overscroll off never reports this.
   */
  fun pageLeftDragUnused() {
    if (state != State.IDLE) unused = true
  }

  fun move(x: Float, y: Float, now: Long): State {
    if (state == State.IDLE) return state
    val dx = x - startX
    val dy = y - startY
    distance = max(0f, dy)
    if (state == State.WATCHING) {
      // Upwards or sideways first means scrolling or swiping, not pulling.
      if (dy < -slop || (abs(dx) > slop && abs(dx) > abs(dy))) {
        reset()
        return state
      }
      if (!unused || dy < showAt) return state
      state = State.PULLING
    }
    if (state == State.PULLING) {
      if (dy >= triggerAt) {
        state = State.HOLDING
        holdSince = now
      }
    } else if (dy < triggerAt - cancelSlack) {
      state = State.PULLING
    }
    return tick(now)
  }

  /** A finger held still sends no moves, so the caller also ticks on a timer. */
  fun tick(now: Long): State {
    if (state == State.HOLDING && now - holdSince >= holdMillis) state = State.ARMED
    return state
  }

  /** The finger lifted: true when the page should reload. */
  fun up(): Boolean {
    val reload = state == State.ARMED
    reset()
    return reload
  }

  fun reset() {
    state = State.IDLE
    distance = 0f
    holdSince = 0L
    unused = false
  }

  companion object {
    const val HOLD_MILLIS = 350L
  }
}
