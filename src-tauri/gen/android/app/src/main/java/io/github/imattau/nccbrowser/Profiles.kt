package io.github.imattau.nccbrowser

import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Separate browsing sessions for private and Tor tabs.
 *
 * Without this every WebView in the app shares one cookie jar, and a cookie ignores the
 * port: a private tab and a normal tab on the same host would read and write the same
 * cookies, and the jar is saved to disk. A WebView profile is a whole separate set of
 * cookies, storage and cache, so a private tab can be given its own and the shared one
 * is never touched.
 *
 * Profiles need a recent WebView. Where there is none, [supported] is false, the tabs
 * fall back to the shared session, and the shell says so instead of promising more.
 *
 * Two rules from the profile API shape the lifecycle. A profile has to be chosen before
 * a WebView is first used. And a profile that has been loaded cannot be deleted in the
 * same run, so its contents are wiped when the last tab using it closes, and anything
 * left from a run that did not get that far is deleted at startup, before any tab can
 * load it.
 */
object Profiles {
  const val PRIVATE = "ncc-private"
  const val TOR = "ncc-tor"

  fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

  /** Point a new WebView at its own profile. Call before it loads anything. */
  fun apply(web: WebView, name: String): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return false
    return try {
      ProfileStore.getInstance().getOrCreateProfile(name)
      WebViewCompat.setProfile(web, name)
      true
    } catch (error: Throwable) {
      false
    }
  }

  /** The cookie jar for a profile, or the shared one for `null` or when unsupported. */
  fun cookieManager(name: String?): CookieManager {
    if (name != null && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      try {
        val profile = ProfileStore.getInstance().getProfile(name)
        if (profile != null) return profile.cookieManager
      } catch (error: Throwable) {
        // Fall through to the shared jar.
      }
    }
    return CookieManager.getInstance()
  }

  fun webStorage(name: String?): WebStorage {
    if (name != null && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      try {
        val profile = ProfileStore.getInstance().getProfile(name)
        if (profile != null) return profile.webStorage
      } catch (error: Throwable) {
        // Fall through to the shared storage.
      }
    }
    return WebStorage.getInstance()
  }

  /** Empty a profile: its cookies and its web storage. The tabs using it are gone. */
  fun wipe(name: String) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
    try {
      val profile = ProfileStore.getInstance().getProfile(name) ?: return
      profile.cookieManager.removeAllCookies(null)
      profile.cookieManager.flush()
      profile.webStorage.deleteAllData()
    } catch (error: Throwable) {
      // A failed wipe is retried by the startup deletion.
    }
  }

  /**
   * Delete what an earlier run left behind. Only possible before this run has loaded
   * the profile, so it belongs at the very start.
   */
  fun reset() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
    val names = try {
      ProfileStore.getInstance().allProfileNames
    } catch (error: Throwable) {
      return
    }
    for (name in listOf(PRIVATE, TOR)) {
      if (!names.contains(name)) continue
      try {
        ProfileStore.getInstance().deleteProfile(name)
      } catch (error: Throwable) {
        // In use or already gone; the wipe on close covers the rest.
      }
    }
  }
}
