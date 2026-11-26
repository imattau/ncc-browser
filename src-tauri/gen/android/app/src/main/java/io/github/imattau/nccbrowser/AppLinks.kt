package io.github.imattau.nccbrowser

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * Links that belong to an installed app, such as a store listing or a video.
 *
 * Handing one over tells that app what was tapped, so it only happens for a link the
 * person followed themselves, in a normal tab, on its way to another site.
 */
object AppLinks {
  /** A link a page is following. No Android types, so the rule can be tested directly. */
  data class Tap(
    val url: String,
    /** The page the link is on, if there is one. */
    val from: String?,
    val kind: LinkMenu.TabKind,
    val mainFrame: Boolean,
    val userGesture: Boolean,
    val redirect: Boolean,
  )

  fun mayHandOff(tap: Tap): Boolean {
    // A private or Tor tab keeps what is read in it away from other apps.
    if (tap.kind != LinkMenu.TabKind.NORMAL) return false
    // Not a frame, a script acting alone, or an address that was only redirected to.
    if (!tap.mainFrame || !tap.userGesture || tap.redirect) return false
    if (!tap.url.startsWith("https://", ignoreCase = true)) return false
    val to = site(tap.url) ?: return false
    // The proxy's own virtual hosts mean nothing outside this browser.
    if (to == "localhost" || to.endsWith(".localhost")) return false
    // Someone reading a site's pages here is not asking to leave for its app.
    return to != tap.from?.let(::site)
  }

  /**
   * Opens the app that is the chosen handler for this address. False leaves the page to
   * load here: nothing handles it, only a browser does, or the choice is not settled.
   *
   * The system makes that judgement from Android 11, without this app having to see
   * what else is installed. Older versions keep every web link in the browser.
   */
  fun open(context: Context, uri: Uri): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
    val intent = Intent(Intent.ACTION_VIEW, uri)
      .addCategory(Intent.CATEGORY_BROWSABLE)
      .addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER or
          Intent.FLAG_ACTIVITY_REQUIRE_DEFAULT,
      )
    return try {
      context.startActivity(intent)
      true
    } catch (_: ActivityNotFoundException) {
      false
    } catch (_: SecurityException) {
      false
    }
  }

  /** The host, without a leading `www.`. Read from the text, as in [LinkMenu]. */
  private fun site(url: String): String? {
    val start = url.indexOf("://")
    if (start < 0) return null
    val authority = url.substring(start + 3).takeWhile { it != '/' && it != '?' && it != '#' && it != '\\' }
    return authority.substringAfterLast('@').substringBefore(':').lowercase()
      .trimEnd('.').removePrefix("www.").takeIf { it.isNotEmpty() }
  }
}
