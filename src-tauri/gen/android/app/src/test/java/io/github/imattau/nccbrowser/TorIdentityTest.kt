package io.github.imattau.nccbrowser

import org.junit.Assert.assertEquals
import org.junit.Test

class TorIdentityTest {
  private val device =
    "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.0.0 Mobile Safari/537.36 NostrNavigator/0.47.19"

  // The same strings the proxy builds, so scripts and headers agree.
  @Test
  fun aTorTabNamesNeitherTheAppNorAWebView() {
    assertEquals(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36",
      TorIdentity.userAgent(device, desktop = false),
    )
  }

  @Test
  fun theDesktopLayoutIsAnOrdinaryLinuxChrome() {
    assertEquals(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      TorIdentity.userAgent(device, desktop = true),
    )
  }
}
