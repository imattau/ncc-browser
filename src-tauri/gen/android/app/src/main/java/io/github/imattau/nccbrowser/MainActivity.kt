package io.github.imattau.nccbrowser

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * Tauri hosts the shell. This activity puts the content surface underneath a
 * 56 dp chrome strip and bridges the two:
 *
 *   shell → content   `window.NccContent.open(url)`, `.close()`, `.back()`,
 *                     `.reload()`, `.expand(bool)`
 *   content → shell   `window.__nccContent({...})`, `window.__nccContentClosed()`
 *
 * The strip is the shell's own WebView resized to one row, so the chrome is still
 * React and still ours. Expanding it gives the shell the whole window again, which is
 * how the address form is edited without a second UI.
 *
 * The bridge is a plain `@JavascriptInterface`, exposed only to the shell's WebView.
 * Pages on the content surface never see it.
 */
class MainActivity : TauriActivity() {
  private var shell: WebView? = null
  private var column: LinearLayout? = null
  private var surface: ContentSurface? = null
  private var backCallback: OnBackPressedCallback? = null
  private var barHeight = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    barHeight = (56 * resources.displayMetrics.density).toInt()

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

    val parent = chromeView.parent as? ViewGroup ?: root
    val index = parent.indexOfChild(chromeView)
    parent.removeView(chromeView)

    val columnView = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
    }
    columnView.addView(
      chromeView,
      LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    parent.addView(
      columnView,
      index,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )

    column = columnView
    shell = chromeView

    // The window is edge-to-edge, so the strip would sit under the status bar and the
    // camera cutout, and the page under the gesture bar. Inset the column once and
    // both halves stay clear.
    ViewCompat.setOnApplyWindowInsetsListener(columnView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(columnView)

    val contentSurface = ContentSurface(columnView) { payload -> postToShell(payload) }
    surface = contentSurface

    val callback = object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        val view = contentSurface
        if (view.back()) return
        view.close()
        setExpanded(false)
        isEnabled = false
      }
    }
    backCallback = callback
    onBackPressedDispatcher.addCallback(this, callback)

    chromeView.addJavascriptInterface(Bridge(contentSurface), "NccContent")

    // The shell page may have loaded before the bridge existed.
    chromeView.evaluateJavascript("window.__nccContentReady && window.__nccContentReady()", null)
  }

  /**
   * Resize the shell between a one-row strip and the whole window.
   *
   * With the strip up, the content surface takes the remaining space; expanded, the
   * strip takes everything and the surface is squeezed to nothing.
   */
  private fun setExpanded(expanded: Boolean) {
    val chromeView = shell ?: return
    val params = chromeView.layoutParams as? LinearLayout.LayoutParams ?: return

    params.height = if (expanded) {
      ViewGroup.LayoutParams.MATCH_PARENT
    } else {
      barHeight
    }
    chromeView.layoutParams = params
    chromeView.requestLayout()

    if (expanded) {
      surface?.hide()
    } else if (surface?.isOpen == true) {
      surface?.show()
    }
  }

  inner class Bridge(private val contentSurface: ContentSurface) {
    @JavascriptInterface
    fun open(url: String) {
      runOnUiThread {
        if (contentSurface.open(url)) {
          setExpanded(false)
          backCallback?.isEnabled = true
        }
      }
    }

    @JavascriptInterface
    fun close() {
      runOnUiThread {
        contentSurface.close()
        setExpanded(true)
        backCallback?.isEnabled = false
      }
    }

    @JavascriptInterface
    fun back() {
      runOnUiThread { contentSurface.back() }
    }

    @JavascriptInterface
    fun reload() {
      runOnUiThread { contentSurface.reload() }
    }

    @JavascriptInterface
    fun expand(expanded: Boolean) {
      runOnUiThread { setExpanded(expanded) }
    }
  }

  private fun postToShell(payload: JSONObject) {
    val view = shell ?: return
    val json = payload.toString()
    view.post {
      view.evaluateJavascript("window.__nccContent && window.__nccContent($json)", null)
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
