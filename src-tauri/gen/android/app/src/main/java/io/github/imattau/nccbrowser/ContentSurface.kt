package io.github.imattau.nccbrowser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * One tab: a WebView plus what the switcher needs to draw it.
 *
 * Pages load straight from `http://<npub>.<service>.localhost:<port>/…`. Chromium
 * resolves `*.localhost` to loopback, so the proxy is reached natively and the
 * document keeps that origin — cookies, storage, service workers and request bodies
 * all behave as they would anywhere else.
 *
 * Clearnet pages load here too, exactly as they do on the desktop: this is a browser,
 * and sending a page to the system browser is a dead end for anything the app knows
 * how to render. The proxy port therefore cannot be read off the current URL — a
 * clearnet page does not carry it — so it is supplied by the activity.
 */
class ContentSurface(
  val id: String,
  private val container: ViewGroup,
  private val proxyPort: () -> Int,
  private val report: (JSONObject) -> Unit,
  private val onDownload: (String, String?, String?) -> Unit,
) {
  private var webView: WebView? = null
  private var showingError = false
  /// Set once the tab is gone, so a callback posted before that cannot touch it.
  private var destroyed = false

  var title: String? = null
    private set
  var currentUrl: String? = null
    private set
  var thumbnail: String? = null
  var lastUsed: Long = System.currentTimeMillis()

  var desktopMode = false
    private set
  private var mobileAgent: String? = null

  val isOpen: Boolean
    get() = webView?.visibility == View.VISIBLE

  fun accepts(url: String): Boolean {
    val scheme = Uri.parse(url).scheme?.lowercase()
    return scheme == "http" || scheme == "https"
  }

  fun open(url: String): Boolean {
    if (!accepts(url)) {
      emit(JSONObject().put("type", "rejected").put("url", url))
      return false
    }
    val web = webView ?: create().also { webView = it }
    web.visibility = View.VISIBLE
    web.loadUrl(url)
    return true
  }

  fun reload() {
    webView?.reload()
  }

  fun clearCache() {
    webView?.clearCache(true)
  }

  fun back(): Boolean {
    val web = webView ?: return false
    if (web.canGoBack()) {
      web.goBack()
      return true
    }
    return false
  }

  fun canGoBack(): Boolean = webView?.canGoBack() == true

  fun canGoForward(): Boolean = webView?.canGoForward() == true

  fun forward() {
    webView?.takeIf { it.canGoForward() }?.goForward()
  }

  fun stop() {
    webView?.stopLoading()
  }

  /** Find in page: results arrive through the find listener as `find` events. */
  fun find(query: String) {
    webView?.findAllAsync(query)
  }

  fun findNext(forward: Boolean) {
    webView?.findNext(forward)
  }

  fun clearFind() {
    webView?.clearMatches()
  }

  /**
   * Ask for the desktop layout: a desktop user agent and a wide viewport, then reload.
   * The mobile agent is remembered so switching back restores exactly what the device
   * reported, including the NostrNavigator suffix.
   */
  fun setDesktopMode(enabled: Boolean) {
    val web = webView ?: return
    if (enabled == desktopMode) return
    desktopMode = enabled

    if (enabled) {
      val chrome = Regex("Chrome/([0-9.]+)").find(web.settings.userAgentString)?.groupValues?.get(1) ?: "120.0.0.0"
      web.settings.userAgentString =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/$chrome Safari/537.36 NostrNavigator/${BuildConfig.VERSION_NAME}"
    } else {
      web.settings.userAgentString = mobileAgent
    }
    web.settings.useWideViewPort = enabled
    web.settings.loadWithOverviewMode = enabled
    web.reload()
  }

  fun show() {
    webView?.visibility = View.VISIBLE
  }

  fun hide() {
    webView?.visibility = View.GONE
  }

  /**
   * Drop this tab.
   *
   * The WebView leaves its parent before `destroy()`: destroying one that is still
   * attached to the window is not allowed and takes the process down with it.
   */
  fun destroy() {
    if (destroyed) return
    destroyed = true

    val web = webView ?: return
    webView = null
    web.stopLoading()
    (web.parent as? ViewGroup)?.removeView(web)
    web.destroy()
  }

  /**
   * Grab what this tab currently looks like, scaled down and JPEG-encoded for the
   * switcher. Only meaningful while the view is visible, which is why the tab manager
   * captures *before* hiding a tab.
   */
  fun capture(onCaptured: (String?) -> Unit) {
    val web = webView
    if (web == null || web.width == 0 || web.height == 0) {
      onCaptured(null)
      return
    }

    val activity = container.context as? Activity
    if (activity == null) {
      onCaptured(null)
      return
    }

    // PixelCopy has no View overload on this SDK: copy the rectangle the view occupies
    // out of the window instead.
    val location = IntArray(2)
    web.getLocationInWindow(location)
    val source = Rect(location[0], location[1], location[0] + web.width, location[1] + web.height)
    val full = Bitmap.createBitmap(source.width(), source.height(), Bitmap.Config.ARGB_8888)
    try {
      PixelCopy.request(
        activity.window,
        source,
        full,
        { result ->
          if (result != PixelCopy.SUCCESS) {
            onCaptured(null)
            return@request
          }
          val small = Bitmap.createScaledBitmap(
            full,
            (web.width / 3).coerceAtLeast(1),
            (web.height / 3).coerceAtLeast(1),
            true,
          )
          val bytes = ByteArrayOutputStream()
          small.compress(Bitmap.CompressFormat.JPEG, 45, bytes)
          onCaptured("data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
        },
        Handler(Looper.getMainLooper()),
      )
    } catch (error: Throwable) {
      onCaptured(null)
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun create(): WebView {
    val web = WebView(container.context)

    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      mediaPlaybackRequiresUserGesture = false
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      userAgentString = "$userAgentString NostrNavigator/${BuildConfig.VERSION_NAME}"
      mobileAgent = userAgentString
      setSupportZoom(true)
      builtInZoomControls = true
      displayZoomControls = false
    }

    web.setFindListener { active, total, _ ->
      emit(JSONObject().put("type", "find").put("current", if (total == 0) 0 else active + 1).put("total", total))
    }

    web.webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) {
        emit(JSONObject().put("type", "progress").put("value", newProgress))
      }

      /**
       * The page's own favicon, shrunk to something a tile or a tab card can carry.
       * The shell keeps it per service, so it outlives the tab.
       */
      override fun onReceivedIcon(view: WebView, icon: Bitmap) {
        val size = 96
        val scale = size.toFloat() / maxOf(icon.width, icon.height).coerceAtLeast(1)
        val small = if (scale < 1f) {
          Bitmap.createScaledBitmap(
            icon,
            (icon.width * scale).toInt().coerceAtLeast(1),
            (icon.height * scale).toInt().coerceAtLeast(1),
            true,
          )
        } else {
          icon
        }
        val bytes = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        emit(
          JSONObject()
            .put("type", "icon")
            .put("url", view.url ?: currentUrl ?: "")
            .put("icon", "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)),
        )
      }
    }

    // A file the WebView will not render becomes a download through the proxy, because
    // this process cannot resolve the virtual host itself.
    web.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
      onDownload(url, mimeType, contentDisposition)
    }

    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        val url = request.url.toString()

        // A page can link to another service or site. Those carry the label rules that
        // live in Rust, so ask the proxy instead of reimplementing base32 here.
        val scheme = request.url.scheme?.lowercase()
        if (scheme == "ncc" || scheme == "nsite") {
          routeLink(view, url)
          return true
        }

        if (accepts(url)) return false

        // Everything else — mailto:, tel:, intent: — belongs to another app.
        val opened = try {
          container.context.startActivity(
            Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
          true
        } catch (error: ActivityNotFoundException) {
          false
        }
        emit(JSONObject().put("type", if (opened) "external" else "blocked").put("url", url))
        return true
      }

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
        // Only the proxy's own listener could present a certificate on a `.localhost`
        // host; endpoints are pinned in Rust before anything is served.
        val host = Uri.parse(error.url ?: "").host?.lowercase() ?: ""
        if (host.endsWith(".localhost")) {
          handler.proceed()
        } else {
          handler.cancel()
        }
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        currentUrl = url
        emit(JSONObject().put("type", "loading").put("url", url ?: ""))
      }

      override fun onPageFinished(view: WebView, url: String?) {
        currentUrl = url
        title = view.title
        if (showingError) {
          showingError = false
          return
        }
        emit(
          JSONObject()
            .put("type", "loaded")
            .put("url", url ?: "")
            .put("title", view.title ?: "")
            .put("canGoBack", view.canGoBack())
            .put("canGoForward", view.canGoForward()),
        )
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: android.webkit.WebResourceError,
      ) {
        if (!request.isForMainFrame) return
        val detail = "${error.errorCode} ${error.description}"
        currentUrl = request.url.toString()
        emit(JSONObject().put("type", "failed").put("url", request.url.toString()).put("reason", detail))
        // Chromium's own error page hides the address that failed, which is the one
        // thing needed to tell a bad address apart from a broken proxy.
        showFailure(view, request.url.toString(), detail)
      }
    }

    web.layoutParams = ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    )
    web.visibility = View.GONE
    container.addView(web)

    return web
  }

  /** Resolve an `ncc://` or `nsite://` link through the proxy, then load it. */
  private fun routeLink(view: WebView, url: String) {
    val port = proxyPort()
    if (port <= 0) {
      emit(JSONObject().put("type", "blocked").put("url", url))
      return
    }

    Thread {
      val resolved = try {
        resolveRoute(port, url)
      } catch (error: Exception) {
        null
      }
      view.post {
        if (destroyed) return@post
        if (resolved != null) {
          view.loadUrl(resolved)
        } else {
          emit(JSONObject().put("type", "blocked").put("url", url))
        }
      }
    }.apply { isDaemon = true }.start()
  }

  private fun resolveRoute(port: Int, url: String): String? {
    val encoded = URLEncoder.encode(url, "UTF-8")
    val connection = URL("http://127.0.0.1:$port/__ncc/route?u=$encoded").openConnection() as HttpURLConnection
    return try {
      connection.connectTimeout = 5000
      connection.readTimeout = 5000
      if (connection.responseCode != 200) {
        null
      } else {
        val body = connection.inputStream.bufferedReader().use { it.readText() }
        JSONObject(body).optString("url").takeIf { it.isNotEmpty() }
      }
    } catch (error: Exception) {
      null
    } finally {
      connection.disconnect()
    }
  }

  private fun emit(payload: JSONObject) {
    if (destroyed) return
    payload.put("tab", id)
    lastUsed = System.currentTimeMillis()
    report(payload)
  }

  private fun showFailure(view: WebView, url: String, detail: String) {
    if (destroyed) return
    showingError = true
    val safeUrl = escapeHtml(url)
    val html = """
      <!doctype html><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <style>
        body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:12vh 24px 24px;
          max-width:34rem;margin-inline:auto}
        h1{font-size:1.4rem;margin:0 0 .5rem}
        p{color:CanvasText;opacity:.75;margin:.25rem 0 1rem}
        code{display:block;padding:.6rem .8rem;border-radius:10px;font-size:.8rem;
          background:color-mix(in srgb,CanvasText 8%,transparent);word-break:break-all}
        a.retry{display:inline-block;margin-top:1.25rem;padding:.8rem 1.6rem;
          border-radius:999px;background:#2457e6;color:#fff;font-weight:600;
          text-decoration:none}
      </style>
      <h1>This page did not load</h1>
      <p>The proxy answered with an error or refused the connection. If the address
      below is right, try again in a moment.</p>
      <code>$safeUrl</code>
      <p><small>${escapeHtml(detail)}</small></p>
      <a class="retry" href="$safeUrl">Try again</a>
    """.trimIndent()

    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }

  private fun escapeHtml(text: String): String =
    text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
}
