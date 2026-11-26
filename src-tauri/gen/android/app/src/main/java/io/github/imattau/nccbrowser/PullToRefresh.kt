package io.github.imattau.nccbrowser

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A WebView that says when a downward drag went unused at the top of the page.
 *
 * `canScrollVertically` only knows about the document, so on a page that scrolls a panel
 * inside it every downward drag looks like a pull. The engine's overscroll is reported
 * only once nothing in the page has taken the drag.
 */
class PageWebView(context: Context) : WebView(context) {
  var onTopOverscroll: (() -> Unit)? = null

  override fun overScrollBy(
    deltaX: Int,
    deltaY: Int,
    scrollX: Int,
    scrollY: Int,
    scrollRangeX: Int,
    scrollRangeY: Int,
    maxOverScrollX: Int,
    maxOverScrollY: Int,
    isTouchEvent: Boolean,
  ): Boolean {
    if (deltaY < 0 && scrollY <= 0) onTopOverscroll?.invoke()
    return super.overScrollBy(
      deltaX, deltaY, scrollX, scrollY, scrollRangeX, scrollRangeY,
      maxOverScrollX, maxOverScrollY, isTouchEvent,
    )
  }
}

/** Runs [PullGesture] on one page and draws what it is about to do. */
class PullToRefresh(
  private val web: PageWebView,
  private val host: ViewGroup,
  private val canReload: () -> Boolean,
  private val reload: () -> Unit,
) {
  private val density = web.resources.displayMetrics.density
  private val gesture = PullGesture(
    slop = 8 * density,
    showAt = 32 * density,
    triggerAt = 120 * density,
    cancelSlack = 20 * density,
  )
  private var indicator: PullIndicator? = null
  private var shown = PullGesture.State.IDLE
  private var refreshing = false
  /** Which touch is current, so a late answer about an earlier one is ignored. */
  private var touch = 0
  private val holdElapsed = Runnable { render(gesture.tick(SystemClock.uptimeMillis())) }
  private val giveUp = Runnable { dismiss() }

  @SuppressLint("ClickableViewAccessibility")
  fun attach() {
    web.onTopOverscroll = { gesture.pageLeftDragUnused() }
    web.setOnTouchListener { _, event -> onTouch(event) }
  }

  /** The reload finished, or the tab left the screen. */
  fun dismiss() {
    refreshing = false
    gesture.reset()
    remove()
  }

  fun pageLoaded() {
    if (refreshing) dismiss()
  }

  /** True keeps the event from the page, which is only once the drag is ours. */
  private fun onTouch(event: MotionEvent): Boolean {
    val wasEngaged = gesture.isEngaged
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        gesture.down(event.x, event.y, !refreshing && canReload() && !web.canScrollVertically(-1))
        askWhetherPageAllows(++touch)
      }
      MotionEvent.ACTION_MOVE -> {
        val state = gesture.move(event.x, event.y, SystemClock.uptimeMillis())
        if (!wasEngaged && gesture.isEngaged) {
          // Hand the rest of the drag over, so moving back up to cancel does not scroll
          // the page underneath.
          val cancel = MotionEvent.obtain(event)
          cancel.action = MotionEvent.ACTION_CANCEL
          web.onTouchEvent(cancel)
          cancel.recycle()
          web.parent?.requestDisallowInterceptTouchEvent(true)
        }
        render(state)
      }
      MotionEvent.ACTION_POINTER_DOWN -> {
        // A second finger is a pinch or a change of mind.
        gesture.reset()
        if (!refreshing) remove()
      }
      MotionEvent.ACTION_UP -> {
        val wanted = gesture.up()
        if (wanted && canReload()) {
          refreshing = true
          indicator?.showRefreshing()
          indicator?.postDelayed(giveUp, REFRESH_TIMEOUT_MILLIS)
          web.removeCallbacks(holdElapsed)
          reload()
        } else if (!refreshing) {
          remove()
        }
      }
      MotionEvent.ACTION_CANCEL -> {
        gesture.reset()
        if (!refreshing) remove()
      }
    }
    return wasEngaged
  }

  /**
   * `overscroll-behavior` on the root is how a page turns pull-to-refresh off, and the
   * engine reports unused drags regardless. The answer arrives well within the hold, and
   * a page lying here can only switch the gesture off for itself.
   */
  private fun askWhetherPageAllows(asked: Int) {
    if (gesture.state == PullGesture.State.IDLE) return
    web.evaluateJavascript("getComputedStyle(document.documentElement).overscrollBehaviorY") { answer ->
      if (asked == touch && (answer == "\"contain\"" || answer == "\"none\"")) {
        gesture.reset()
        if (!refreshing) remove()
      }
    }
  }

  private fun render(state: PullGesture.State) {
    if (!gesture.isEngaged) {
      if (!refreshing) remove()
      return
    }
    val view = indicator ?: PullIndicator(web.context).also {
      indicator = it
      host.addView(
        it,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
          Gravity.TOP or Gravity.CENTER_HORIZONTAL,
        ),
      )
    }
    // Follows the finger a little, then stops.
    view.translationY = (8 * density) + (40 * density) * gesture.pullFraction
    view.alpha = 0.35f + 0.65f * gesture.pullFraction
    when (state) {
      PullGesture.State.HOLDING -> if (shown != state) {
        view.showHolding(PullGesture.HOLD_MILLIS)
        web.removeCallbacks(holdElapsed)
        web.postDelayed(holdElapsed, PullGesture.HOLD_MILLIS)
      }
      PullGesture.State.ARMED -> if (shown != state) {
        view.showArmed()
        web.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      }
      else -> {
        web.removeCallbacks(holdElapsed)
        view.showPulling(gesture.pullFraction, cancelled = shown == PullGesture.State.ARMED || view.isCancelled)
      }
    }
    shown = state
  }

  private fun remove() {
    web.removeCallbacks(holdElapsed)
    shown = PullGesture.State.IDLE
    indicator?.let {
      it.removeCallbacks(giveUp)
      it.stop()
      (it.parent as? ViewGroup)?.removeView(it)
    }
    indicator = null
  }

  private companion object {
    const val REFRESH_TIMEOUT_MILLIS = 10_000L
  }
}

/** The pill at the top of the page: a ring and what letting go would do. */
private class PullIndicator(context: Context) : LinearLayout(context) {
  private val density = resources.displayMetrics.density
  private val ring = Ring(context)
  private val label = TextView(context)
  private val background = GradientDrawable()
  var isCancelled = false
    private set

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    background.cornerRadius = 22 * density
    setBackground(background)
    elevation = 6 * density
    setPadding(dp(14), dp(10), dp(18), dp(10))
    addView(ring, LayoutParams(dp(20), dp(20)))
    label.setTextColor(Color.WHITE)
    label.textSize = 14f
    label.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    addView(label, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      marginStart = dp(10)
    })
  }

  /** Before the trigger point, or taken back after arming. */
  fun showPulling(fraction: Float, cancelled: Boolean) {
    isCancelled = cancelled
    style(if (cancelled) "Let go to cancel" else "Pull down to refresh", armed = false)
    // The first half of the ring is the pull; the hold completes it.
    ring.set(if (cancelled) 0f else fraction * 0.5f)
  }

  fun showHolding(millis: Long) {
    isCancelled = false
    style("Hold to refresh", armed = false)
    ring.animateTo(1f, millis)
  }

  fun showArmed() {
    style("Release to refresh · slide up to cancel", armed = true)
    ring.set(1f)
  }

  fun showRefreshing() {
    style("Refreshing…", armed = true)
    ring.spin()
  }

  fun stop() = ring.stop()

  private fun style(text: String, armed: Boolean) {
    if (label.text.toString() != text) label.text = text
    background.setColor(if (armed) Color.parseColor("#4F46E5") else Color.parseColor("#20242C"))
  }

  private fun dp(value: Int) = (value * density).toInt()

  private class Ring(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 2.5f * resources.displayMetrics.density
      strokeCap = Paint.Cap.ROUND
      color = Color.WHITE
    }
    private val bounds = RectF()
    private var filled = 0f
    private var turn = 0f
    private var animator: android.animation.ValueAnimator? = null

    fun set(value: Float) {
      stop()
      filled = value
      invalidate()
    }

    fun animateTo(value: Float, millis: Long) {
      stop()
      animator = android.animation.ValueAnimator.ofFloat(filled.coerceAtLeast(0.5f), value).apply {
        duration = millis
        interpolator = android.view.animation.LinearInterpolator()
        addUpdateListener {
          filled = it.animatedValue as Float
          invalidate()
        }
        start()
      }
    }

    fun spin() {
      stop()
      filled = 0.75f
      animator = android.animation.ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 800
        repeatCount = android.animation.ValueAnimator.INFINITE
        interpolator = android.view.animation.LinearInterpolator()
        addUpdateListener {
          turn = it.animatedValue as Float
          invalidate()
        }
        start()
      }
    }

    fun stop() {
      animator?.cancel()
      animator = null
      turn = 0f
    }

    override fun onDraw(canvas: Canvas) {
      val inset = paint.strokeWidth / 2
      bounds.set(inset, inset, width - inset, height - inset)
      paint.alpha = 70
      canvas.drawArc(bounds, 0f, 360f, false, paint)
      paint.alpha = 255
      canvas.drawArc(bounds, turn - 90f, 360f * filled, false, paint)
    }
  }
}
