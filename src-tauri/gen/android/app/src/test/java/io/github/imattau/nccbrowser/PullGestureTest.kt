package io.github.imattau.nccbrowser

import io.github.imattau.nccbrowser.PullGesture.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PullGestureTest {
  private fun gesture() = PullGesture(slop = 8f, showAt = 32f, triggerAt = 120f, cancelSlack = 20f, holdMillis = 350L)

  /** A drag from the top of a page that has no use for it. */
  private fun pulling(): PullGesture = gesture().apply {
    down(100f, 100f, atTop = true)
    pageLeftDragUnused()
  }

  @Test fun pullHoldAndReleaseReloads() {
    val pull = pulling()
    assertEquals(State.PULLING, pull.move(100f, 160f, 0))
    assertEquals(State.HOLDING, pull.move(100f, 240f, 100))
    assertEquals(State.HOLDING, pull.tick(449))
    assertEquals(State.ARMED, pull.tick(450))
    assertTrue(pull.up())
  }

  @Test fun aFlickDoesNotReload() {
    val pull = pulling()
    pull.move(100f, 400f, 0)
    pull.move(100f, 600f, 80)
    assertFalse(pull.up())
  }

  @Test fun lettingGoShortOfTheTriggerDoesNotReload() {
    val pull = pulling()
    pull.move(100f, 200f, 0)
    assertEquals(State.PULLING, pull.tick(5_000))
    assertFalse(pull.up())
  }

  @Test fun slidingBackUpTakesItBack() {
    val pull = pulling()
    pull.move(100f, 250f, 0)
    assertEquals(State.ARMED, pull.tick(400))
    assertEquals(State.PULLING, pull.move(100f, 190f, 500))
    assertEquals(State.PULLING, pull.move(100f, 90f, 600))
    assertTrue(pull.isEngaged)
    assertFalse(pull.up())
  }

  @Test fun aSmallWobbleKeepsItArmed() {
    val pull = pulling()
    pull.move(100f, 250f, 0)
    pull.tick(400)
    assertEquals(State.ARMED, pull.move(100f, 210f, 500))
  }

  @Test fun pullingDownAgainStartsTheHoldOver() {
    val pull = pulling()
    pull.move(100f, 250f, 0)
    pull.tick(400)
    pull.move(100f, 150f, 500)
    assertEquals(State.HOLDING, pull.move(100f, 250f, 600))
    assertEquals(State.HOLDING, pull.tick(900))
    assertEquals(State.ARMED, pull.tick(950))
  }

  @Test fun aDragThePageUsesIsNotAPull() {
    val pull = gesture()
    pull.down(100f, 100f, atTop = true)
    assertEquals(State.WATCHING, pull.move(100f, 400f, 0))
    pull.tick(5_000)
    assertFalse(pull.isEngaged)
    assertFalse(pull.up())
  }

  @Test fun aDragStartingDownThePageIsNotAPull() {
    val pull = gesture()
    pull.down(100f, 100f, atTop = false)
    pull.pageLeftDragUnused()
    assertEquals(State.IDLE, pull.move(100f, 400f, 0))
    assertFalse(pull.up())
  }

  @Test fun scrollingOrSwipingFirstIsNotAPull() {
    for ((x, y) in listOf(100f to 80f, 140f to 105f)) {
      val pull = pulling()
      assertEquals(State.IDLE, pull.move(x, y, 0))
      assertEquals(State.IDLE, pull.move(100f, 400f, 100))
    }
  }

  @Test fun overscrollFromAnEarlierDragIsForgotten() {
    val pull = pulling()
    pull.up()
    pull.down(100f, 100f, atTop = true)
    assertEquals(State.WATCHING, pull.move(100f, 400f, 0))
  }
}
