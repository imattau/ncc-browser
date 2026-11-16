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
import org.json.JSONObject

/**
 * The surface that renders third-party NCC pages.
 *
 * Tauri hosts the shell (its own WebView) and does not expose the Android view
 * hierarchy, so this view is added by hand on top of it. A page is only ever loaded
 * from a `*.localhost` virtual host served by the NCC proxy: any other host or scheme
 * is refused, because the content view has no business talking to the clearnet
 * directly.
 *
 * State changes are reported to the shell as JSON so the chrome can show the address
 * and title once it exists.
 */
class ContentSurface(
  private val container: ViewGroup,
  private val report: (JSONObject) -> Unit,
) {
  private var webView: WebView? = null

  val isOpen: Boolean
    get() = webView?.visibility == View.VISIBLE

  /** True when the URL is something the proxy could have served. */
  fun accepts(url: String): Boolean {
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase() ?: return false
    return (scheme == "http" || scheme == "https") && host.endsWith(".localhost")
  }

  fun open(url: String): Boolean {
    if (!accepts(url)) {
      val payload = JSONObject()
        .put("type", "rejected")
        .put("url", url)
        .put("reason", "only *.localhost virtual hosts are rendered here")
      report(payload)
      return false
    }

    val web = webView ?: create().also { webView = it }
    web.visibility = View.VISIBLE
    web.loadUrl(url)
    return true
  }

  fun close() {
    webView?.visibility = View.GONE
    report(JSONObject().put("type", "closed"))
  }

  /** Returns true when the GoBack was consumed by the page history. */
  fun back(): Boolean {
    val web = webView ?: return false
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
      // The proxy speaks plain HTTP to `*.localhost` today. A page that mixes in a
      // real https subresource should still render; the alternative is a blank page
      // with no explanation.
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      userAgentString = "$userAgentString NostrNavigator/${BuildConfig.VERSION_NAME}"
    }

    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        val url = request.url.toString()
        if (accepts(url)) {
          return false
        }
        report(
          JSONObject()
            .put("type", "blocked")
            .put("url", url)
            .put("reason", "left the NCC namespace"),
        )
        return true
      }

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
        val host = Uri.parse(error.url ?: "").host?.lowercase() ?: ""
        if (host.endsWith(".localhost")) {
          // The proxy's own certificate. The endpoint fingerprint was already
          // checked in Rust before the response was served.
          handler.proceed()
        } else {
          handler.cancel()
        }
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        report(JSONObject().put("type", "loading").put("url", url ?: ""))
      }

      override fun onPageFinished(view: WebView, url: String?) {
        val payload = JSONObject()
          .put("type", "loaded")
          .put("url", url ?: "")
          .put("title", view.title ?: "")
          .put("canGoBack", view.canGoBack())
        report(payload)
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: android.webkit.WebResourceError,
      ) {
        // Only main-frame failures matter; a broken subresource is the page's problem.
        if (!request.isForMainFrame) return
        report(
          JSONObject()
            .put("type", "failed")
            .put("url", request.url.toString())
            .put("reason", error.description?.toString() ?: "network error"),
        )
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
}
