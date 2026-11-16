package io.github.imattau.nccbrowser

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

/**
 * Tauri hosts the shell. This activity adds the content surface on top of it and
 * bridges the two:
 *
 *   shell → content   `window.NccContent.open(url)`, `.close()`, `.back()`
 *   content → shell   `window.__nccContent({...})`, `window.__nccContentClosed()`
 *
 * The bridge is a plain `@JavascriptInterface`, which is only exposed to the shell's
 * own WebView. Pages on the content surface never see it.
 */
class MainActivity : TauriActivity() {
  private var chrome: WebView? = null
  private var surface: ContentSurface? = null
  private var backCallback: OnBackPressedCallback? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val root = findViewById<ViewGroup>(android.R.id.content)
    root.post { install(root) }
  }

  /**
   * Tauri attaches its WebView during `super.onCreate`, but not necessarily before
   * this returns; wait for it rather than silently ending up without a bridge.
   */
  private fun install(root: ViewGroup, attempt: Int = 0) {
    val chromeView = findWebView(root)
    if (chromeView == null) {
      if (attempt < 40) root.postDelayed({ install(root, attempt + 1) }, 50)
      return
    }
    chrome = chromeView

    val contentSurface = ContentSurface(root) { payload -> postToChrome(payload) }
    surface = contentSurface

    val callback = object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        val view = contentSurface
        if (view.back()) return
        view.close()
        isEnabled = false
      }
    }
    backCallback = callback
    onBackPressedDispatcher.addCallback(this, callback)

    chromeView.addJavascriptInterface(Bridge(contentSurface), "NccContent")

    // The chrome page may have loaded before the bridge existed.
    chromeView.evaluateJavascript("window.__nccContentReady && window.__nccContentReady()", null)
  }

  inner class Bridge(private val contentSurface: ContentSurface) {
    @JavascriptInterface
    fun open(url: String) {
      runOnUiThread {
        if (contentSurface.open(url)) {
          backCallback?.isEnabled = true
        }
      }
    }

    @JavascriptInterface
    fun close() {
      runOnUiThread {
        contentSurface.close()
        backCallback?.isEnabled = false
      }
    }

    @JavascriptInterface
    fun back() {
      runOnUiThread { contentSurface.back() }
    }
  }

  private fun postToChrome(payload: JSONObject) {
    val view = chrome ?: return
    val json = payload.toString()
    view.post {
      view.evaluateJavascript(
        "window.__nccContent && window.__nccContent($json)",
        null,
      )
    }
  }

  override fun onDestroy() {
    surface?.destroy()
    surface = null
    super.onDestroy()
  }

  private fun findWebView(root: ViewGroup): WebView? {
    for (index in 0 until root.childCount) {
      val child = root.getChildAt(index)
      if (child is WebView) return child
      if (child is ViewGroup) {
        findWebView(child)?.let { return it }
      }
    }
    return null
  }
}
