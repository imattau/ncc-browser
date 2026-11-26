package io.github.imattau.nccbrowser

import android.webkit.WebSettings
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * What a Tor tab tells page scripts about the browser. The Tor proxy rewrites the
 * request headers to match (`anonymise` in `onion.rs`); without this, a script could
 * read what the headers no longer say.
 */
object TorIdentity {
  /** Chrome's reduced user agent: neither this app nor a WebView is named in it. */
  fun userAgent(deviceAgent: String, desktop: Boolean): String {
    val major = Regex("Chrome/([0-9]+)").find(deviceAgent)?.groupValues?.get(1) ?: "145"
    val platform = if (desktop) "X11; Linux x86_64" else "Linux; Android 10; K"
    val mobile = if (desktop) "" else " Mobile"
    return "Mozilla/5.0 ($platform) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0$mobile Safari/537.36"
  }

  /**
   * Replace what `navigator.userAgentData` reports, which otherwise names "Android
   * WebView" and can give the device model. A WebView setting rather than a script,
   * so that workers and blank frames get it too.
   */
  fun applyClientHints(settings: WebSettings, desktop: Boolean) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return
    val major = Regex("Chrome/([0-9]+)").find(settings.userAgentString)?.groupValues?.get(1) ?: return
    val brands = listOf("Not:A-Brand" to "99", "Chromium" to major, "Google Chrome" to major).map { (brand, version) ->
      UserAgentMetadata.BrandVersion.Builder()
        .setBrand(brand).setMajorVersion(version).setFullVersion("$version.0.0.0").build()
    }
    WebSettingsCompat.setUserAgentMetadata(
      settings,
      UserAgentMetadata.Builder()
        .setBrandVersionList(brands)
        .setFullVersion("$major.0.0.0")
        .setPlatform(if (desktop) "Linux" else "Android")
        .setPlatformVersion(if (desktop) "" else "10.0.0")
        .setArchitecture("")
        .setModel("")
        .setMobile(!desktop)
        .build(),
    )
  }

  /**
   * Run at document start in every frame, after the other bridges: their shims have
   * taken their references by then, so the app-named globals can go.
   */
  const val SCRIPT = """
(function () {
  function fixed(name, value) {
    try {
      Object.defineProperty(Navigator.prototype, name, { configurable: true, enumerable: true, get: function () { return value; } });
    } catch (e) {}
  }
  var languages = Object.freeze(['en-US', 'en']);
  fixed('language', 'en-US');
  fixed('languages', languages);
  try { delete window.__nccWebln; } catch (e) {}
  try { delete window.__nccNip07; } catch (e) {}
})();
"""
}
