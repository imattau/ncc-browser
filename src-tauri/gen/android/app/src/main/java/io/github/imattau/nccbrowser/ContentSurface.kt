package io.github.imattau.nccbrowser

import android.annotation.SuppressLint
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.TimeUnit

/**
 * The surface that renders third-party NCC pages.
 *
 * Android's resolver does not map `*.localhost` to loopback, so the virtual host
 * cannot be reached over DNS. Instead every request for such a host is intercepted
 * before it leaves the WebView and replayed against the proxy at `127.0.0.1:<port>`,
 * with the vhost carried in `x-ncc-vhost`.
 *
 * Interception is not a workaround for the origin model — it preserves it. The
 * document URL, and therefore the origin, cookies, storage and service-worker scope,
 * stay `http://<npub>.<service>.localhost:<port>`.
 *
 * Known gaps, all because the WebView hands us a request without its body:
 * - submitted form bodies are not forwarded;
 * - only the last `Set-Cookie` survives;
 * - service-worker and WebSocket traffic is not intercepted at all.
 *
 * State changes are reported to the shell as JSON so the chrome can show the address
 * and title once it exists.
 */
class ContentSurface(
  private val container: ViewGroup,
  private val report: (JSONObject) -> Unit,
) {
  private var webView: WebView? = null
  private var proxyPort: Int = -1
  private var showingError = false
  // Separate from visibility: the surface stays "open" while the shell is expanded
  // over it, and must come back when the strip returns.
  private var active = false

  private val client = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

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

    val uri = Uri.parse(url)
    proxyPort = if (uri.port > 0) uri.port else proxyPort

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
    webView?.reload()
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
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? {
        val host = request.url.host?.lowercase() ?: return null
        if (!host.endsWith(".localhost")) return null
        return proxy(request.url, request.method, request.requestHeaders)
      }

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

  /** Replay one vhost request against the proxy, following internal redirects. */
  private fun proxy(
    url: Uri,
    method: String,
    headers: Map<String, String>,
  ): WebResourceResponse {
    if (proxyPort <= 0) return page(500, "No proxy", "The NCC proxy is not running.")

    var current = url
    var hops = 0

    while (hops++ < 6) {
      val target = "http://127.0.0.1:$proxyPort" +
        (current.encodedPath ?: "/") +
        (current.encodedQuery?.let { "?$it" } ?: "")

      val builder = Request.Builder()
        .url(target)
        .header("x-ncc-vhost", "${current.host}:${current.port}")

      headers.forEach { (name, value) ->
        when (name.lowercase()) {
          "host", "connection", "accept-encoding", "content-length" -> Unit
          else -> builder.header(name, value)
        }
      }

      val hasBody = method != "GET" && method != "HEAD"
      builder.method(method, if (hasBody) ByteArray(0).toRequestBody() else null)

      val response = try {
        client.newCall(builder.build()).execute()
      } catch (error: Exception) {
        return page(502, "Proxy unreachable", error.toString())
      }

      val location = response.header("Location")
      if (response.code in 300..399 && !location.isNullOrEmpty()) {
        response.close()
        val next = try {
          Uri.parse(java.net.URL(java.net.URL(current.toString()), location).toString())
        } catch (error: Exception) {
          return page(502, "Bad redirect", location)
        }
        if (!(next.host ?: "").lowercase().endsWith(".localhost")) {
          return page(403, "Left the NCC namespace", next.toString())
        }
        current = next
        continue
      }

      return toResponse(response)
    }

    return page(508, "Too many redirects", url.toString())
  }

  private fun toResponse(response: okhttp3.Response): WebResourceResponse {
    val mime = response.header("Content-Type")?.substringBefore(';') ?: "application/octet-stream"
    val headers = mutableMapOf<String, String>()
    val source = response.headers
    for (index in 0 until source.size) {
      val name = source.name(index)
      val value = source.value(index)
      when (name.lowercase()) {
        "content-type", "content-length", "content-encoding", "transfer-encoding" -> Unit
        else -> headers[name] = value
      }
    }
    val body = response.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
    return WebResourceResponse(mime, null, response.code, response.message.ifEmpty { "OK" }, headers, body)
  }

  private fun page(status: Int, title: String, detail: String): WebResourceResponse =
    WebResourceResponse(
      "text/html",
      "utf-8",
      status,
      title,
      emptyMap(),
      ByteArrayInputStream(
        """
        <!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font:15px system-ui;margin:2rem;max-width:40rem;color:#111}
        code{background:#eee;padding:.1rem .3rem;border-radius:3px;word-break:break-all}</style>
        <h1>$title</h1><p><code>$detail</code></p>
        """.trimIndent().toByteArray(),
      ),
    )

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
