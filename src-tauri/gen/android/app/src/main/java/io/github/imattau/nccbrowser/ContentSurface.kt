package io.github.imattau.nccbrowser

import android.annotation.SuppressLint
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import org.json.JSONObject

/**
 * The surface that renders third-party NCC pages.
 *
 * The page is loaded straight from its virtual host:
 * `http://<npub>.<service>.localhost:<port>/…`. Chromium resolves `*.localhost` to
 * loopback, so the request reaches the NCC proxy without DNS and without any
 * interception — the document keeps that origin, and with it cookies, storage,
 * service workers, request bodies and multiple `Set-Cookie` headers, all natively.
 *
 * Anything that is not one of those hosts is refused: the content view has no
 * business talking to the clearnet directly.
 *
 * State changes are reported to the shell as JSON so the chrome strip can show the
 * address and title.
 */
class ContentSurface(
  private val container: ViewGroup,
  private val report: (JSONObject) -> Unit,
) {
  private var webView: WebView? = null
  private var showingError = false
  // Separate from visibility: the surface stays "open" while the shell is expanded
  // over it, and must come back when the strip returns.
  private var active = false

  val isOpen: Boolean
    get() = active

  /** True when the URL is something the proxy could have served. */
  fun accepts(url: String): Boolean {
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase() ?: return false
    return (scheme == "http" || scheme == "https") && host.endsWith(".localhost")
  }

  fun open(url: String): Boolean {
    if (!accepts(url)) {
      report(
        JSONObject()
          .put("type", "rejected")
          .put("url", url)
          .put("reason", "only *.localhost virtual hosts are rendered here"),
      )
      return false
    }

    val web = webView ?: create().also { webView = it }
    active = true
    web.visibility = View.VISIBLE
    web.loadUrl(url)
    return true
  }

  fun close() {
    active = false
    webView?.visibility = View.GONE
    report(JSONObject().put("type", "closed"))
  }

  /** Reveal the surface without navigating; used when the chrome strip collapses. */
  fun show() {
    if (active) webView?.visibility = View.VISIBLE
  }

  /** Hide the surface while the shell takes the whole window (address editing). */
  fun hide() {
    webView?.visibility = View.GONE
  }

  fun reload() {
    if (active) webView?.reload()
  }

  /** Returns true when the GoBack was consumed by the page history. */
  fun back(): Boolean {
    val web = webView ?: return false
    if (!active) return false
    if (web.canGoBack()) {
      web.goBack()
      return true
    }
    return false
  }

  fun destroy() {
    webView?.destroy()
    container.removeView(webView)
    webView = null
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
        if (accepts(url)) return false
        report(
          JSONObject()
            .put("type", "blocked")
            .put("url", url)
            .put("reason", "left the NCC namespace"),
        )
        return true
      }

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
        // Only the proxy's own listener could ever present a certificate on a
        // `.localhost` host; endpoints are pinned in Rust before anything is served.
        val host = Uri.parse(error.url ?: "").host?.lowercase() ?: ""
        if (host.endsWith(".localhost")) {
          handler.proceed()
        } else {
          handler.cancel()
        }
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        report(JSONObject().put("type", "loading").put("url", url ?: ""))
      }

      override fun onPageFinished(view: WebView, url: String?) {
        if (showingError) {
          showingError = false
          return
        }
        report(
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
        report(
          JSONObject()
            .put("type", "failed")
            .put("url", request.url.toString())
            .put("reason", detail),
        )
        // Chromium's own error page hides the address that failed, which is the one
        // thing needed to tell a bad address apart from a broken proxy.
        showFailure(view, request.url.toString(), detail)
      }
    }

    // Height 0 with weight 1: the surface takes whatever the chrome strip leaves.
    web.layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1f,
    )
    web.visibility = View.GONE
    container.addView(web)

    return web
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
      the connection. Go back to the shell to see the proxy port.</p>
    """.trimIndent()

    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }
}
