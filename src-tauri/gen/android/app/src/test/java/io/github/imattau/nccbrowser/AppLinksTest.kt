package io.github.imattau.nccbrowser

import io.github.imattau.nccbrowser.LinkMenu.TabKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLinksTest {
  private val tap = AppLinks.Tap(
    url = "https://zapstore.dev/apps/io.github.imattau.nccbrowser",
    from = "http://abc.web.localhost:5000/",
    kind = TabKind.NORMAL,
    mainFrame = true,
    userGesture = true,
    redirect = false,
  )

  @Test
  fun aTapOnAnotherSitesLinkMayOpenItsApp() {
    assertTrue(AppLinks.mayHandOff(tap))
    assertTrue(AppLinks.mayHandOff(tap.copy(from = "https://example.com/")))
    assertTrue(AppLinks.mayHandOff(tap.copy(from = null)))
    assertTrue(AppLinks.mayHandOff(tap.copy(from = "about:blank")))
  }

  @Test
  fun privateAndTorTabsKeepTheirLinks() {
    assertFalse(AppLinks.mayHandOff(tap.copy(kind = TabKind.PRIVATE)))
    assertFalse(AppLinks.mayHandOff(tap.copy(kind = TabKind.TOR)))
  }

  @Test
  fun onlyAFollowedLinkCounts() {
    assertFalse(AppLinks.mayHandOff(tap.copy(mainFrame = false)))
    assertFalse(AppLinks.mayHandOff(tap.copy(userGesture = false)))
    assertFalse(AppLinks.mayHandOff(tap.copy(redirect = true)))
  }

  @Test
  fun movingAroundOneSiteStaysHere() {
    for (from in listOf(
      "https://zapstore.dev/apps",
      "https://www.zapstore.dev/",
      "https://ZAPSTORE.dev.:443/x",
    )) {
      assertFalse(from, AppLinks.mayHandOff(tap.copy(from = from)))
    }
    // A name that only looks like the same site is another one.
    assertTrue(AppLinks.mayHandOff(tap.copy(from = "https://zapstore.dev@evil.example/")))
  }

  @Test
  fun onlyPublicHttpsAddressesLeave() {
    for (url in listOf(
      "http://zapstore.dev/apps",
      "ncc://abc/web",
      "market://details?id=x",
      "https://abc.web.localhost:5000/",
      "https://localhost/",
      "https:///nothing",
    )) {
      assertFalse(url, AppLinks.mayHandOff(tap.copy(url = url)))
    }
  }
}
