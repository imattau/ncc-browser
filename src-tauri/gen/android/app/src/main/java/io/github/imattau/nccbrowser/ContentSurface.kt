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
 * Anything that is not one of those hosts is refused: the content view has no business
 * talking to the clearnet directly.
 */
class ContentSurface(
  val id: String,
  private val container: ViewGroup,
  private val report: (JSONObject) -> Unit,
) {
  private var webView: WebView? = null
  private var showingError = false

  var title: String? = null
    private set
  var currentUrl: String? = null
    private set
  var thumbnail: String? = null
  var lastUsed: Long = System.currentTimeMillis()

  val isOpen: Boolean
    get() = webView?.visibility == View.VISIBLE

  fun accepts(url: String): Boolean {
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase() ?: return false
    return (scheme == "http" || scheme == "https") && host.endsWith(".localhost")
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

  fun show() {
    webView?.visibility = View.VISIBLE
  }

  fun hide() {
    webView?.visibility = View.GONE
  }

  fun destroy() {
    webView?.destroy()
    webView?.let { container.removeView(it) }
    webView = null
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

        // Clearnet stays out of the content view on purpose, but a link should still
        // go somewhere: hand it to whatever the device uses for browsing.
        if (scheme == "http" || scheme == "https") {
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

        emit(JSONObject().put("type", "blocked").put("url", url))
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
            .put("canGoBack", view.canGoBack()),
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
    val port = Uri.parse(view.url ?: "").port
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
    payload.put("tab", id)
    lastUsed = System.currentTimeMillis()
    report(payload)
  }

  private fun showFailure(view: WebView, url: String, detail: String) {
    showingError = true
    val html = """
      <!doctype html><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font:15px system-ui;margin:2rem;max-width:40rem;color:#111}
      code{background:#eee;padding:.1rem .3rem;border-radius:3px;word-break:break-all}</style>
      <h1>This page did not load</h1>
      <p><code>$detail</code></p>
      <p>Address: <code>$url</code></p>
      <p>If the address above is right, the proxy answered with an error or refused
      the connection.</p>
    """.trimIndent()

    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }
}
