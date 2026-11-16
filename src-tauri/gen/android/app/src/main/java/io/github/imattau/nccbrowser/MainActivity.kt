package io.github.imattau.nccbrowser

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Tauri hosts the shell. This activity puts a 56 dp chrome strip and a tab container
 * into one column, and bridges the two:
 *
 *   shell → tabs   `window.NccContent.open(url)`, `.openNew(url)`, `.select(id)`,
 *                  `.closeTab(id)`, `.next()`, `.prev()`, `.tabs()`, `.capture()`,
 *                  `.back()`, `.reload()`, `.expand(bool)`, `.setBarPosition(…)`
 *   tabs → shell   `window.__nccContent({...})`, `window.__nccTabs({...})`
 *
 * The strip is the shell's own WebView resized to one row, so the chrome stays ours
 * and the React build can take it over without changing the layout. Expanding gives
 * the shell the whole window, which is how the address sheet and the tab switcher are
 * shown without a second UI.
 *
 * The bridge is a plain `@JavascriptInterface`, exposed only to the shell's WebView.
 * Pages never see it.
 */
class MainActivity : TauriActivity() {
  private var shell: WebView? = null
  private var column: LinearLayout? = null
  private var contentHost: FrameLayout? = null
  private var backCallback: OnBackPressedCallback? = null
  private var barHeight = 0
  private var expanded = true
  private var barAtBottom = true

  private val tabs = mutableListOf<ContentSurface>()
  private var pendingDownload: File? = null

  /**
   * Saving goes through the system picker: no storage permission, and the user chooses
   * where a file lands.
   */
  private val saveDownload =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val file = pendingDownload
      pendingDownload = null
      val target = result.data?.data

      if (result.resultCode != Activity.RESULT_OK || target == null || file == null) {
        file?.delete()
        return@registerForActivityResult
      }

      try {
        file.inputStream().use { input ->
          contentResolver.openOutputStream(target)?.use { output -> input.copyTo(output) }
        }
        toast("Saved")
      } catch (error: Exception) {
        toast("Could not save: ${error.message}")
      } finally {
        file.delete()
      }
    }
  private var activeId: String? = null
  private var nextTabId = 1

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

    val columnView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val host = FrameLayout(this)

    columnView.addView(host, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    columnView.addView(
      chromeView,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barHeight),
    )

    parent.addView(
      columnView,
      index,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )

    column = columnView
    contentHost = host
    shell = chromeView

    // The window is edge-to-edge, so both halves would sit under the status bar, the
    // camera cutout and the gesture bar. Inset the column once and everything stays
    // clear of them.
    ViewCompat.setOnApplyWindowInsetsListener(columnView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(columnView)

    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (active()?.back() == true) return
        if (tabs.isNotEmpty()) {
          closeTab(activeId)
          return
        }
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
      }
    }
    backCallback = callback
    onBackPressedDispatcher.addCallback(this, callback)

    chromeView.addJavascriptInterface(Bridge(), "NccContent")

    chromeView.evaluateJavascript("window.__nccContentReady && window.__nccContentReady()", null)
  }

  private fun active(): ContentSurface? = tabs.firstOrNull { it.id == activeId }

  private fun setExpanded(value: Boolean) {
    expanded = value
    val chromeView = shell ?: return
    val params = chromeView.layoutParams as? LinearLayout.LayoutParams ?: return
    params.height = if (value) ViewGroup.LayoutParams.MATCH_PARENT else barHeight
    chromeView.layoutParams = params
    chromeView.requestLayout()

    if (value) {
      active()?.hide()
    } else {
      active()?.show()
    }
  }

  private fun applyBarPosition(position: String) {
    barAtBottom = position != "top"
    val columnView = column ?: return
    val chromeView = shell ?: return
    val host = contentHost ?: return

    columnView.removeAllViews()
    if (barAtBottom) {
      columnView.addView(host, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
      columnView.addView(chromeView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, if (expanded) ViewGroup.LayoutParams.MATCH_PARENT else barHeight))
    } else {
      columnView.addView(chromeView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, if (expanded) ViewGroup.LayoutParams.MATCH_PARENT else barHeight))
      columnView.addView(host, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }
  }

  /** Capture the visible tab, then run `then` — thumbnails only work while visible. */
  private fun captureActive(then: () -> Unit) {
    val current = active()
    if (current == null) {
      then()
      return
    }
    current.capture { data ->
      if (data != null) current.thumbnail = data
      then()
    }
  }

  private fun openTab(url: String, reuseActive: Boolean): Boolean {
    if (reuseActive) {
      val current = active()
      if (current != null && current.open(url)) {
        setExpanded(false)
        emitTabs(false)
        return true
      }
    }

    captureActive {
      val tab = ContentSurface(
        "tab-${nextTabId++}",
        contentHost ?: return@captureActive,
        ::onTabEvent,
        ::startDownload,
      )
      if (!tab.open(url)) {
        tab.destroy()
        return@captureActive
      }
      active()?.hide()
      tabs.add(tab)
      activeId = tab.id
      setExpanded(false)
      emitTabs(false)
    }
    return true
  }

  private fun selectTab(id: String) {
    val target = tabs.firstOrNull { it.id == id } ?: return
    if (target.id == activeId) return

    captureActive {
      active()?.hide()
      activeId = target.id
      target.show()
      setExpanded(false)
      emitTabs(false)
    }
  }

  private fun closeTab(id: String?) {
    val target = tabs.firstOrNull { it.id == id } ?: return
    val position = tabs.indexOf(target)
    tabs.remove(target)
    target.destroy()

    if (tabs.isEmpty()) {
      activeId = null
      setExpanded(true)
    } else {
      val next = tabs.getOrNull(position) ?: tabs.last()
      activeId = next.id
      next.show()
      setExpanded(false)
    }
    emitTabs(false)
  }

  private fun step(offset: Int) {
    if (tabs.size < 2) return
    val index = tabs.indexOfFirst { it.id == activeId }
    if (index < 0) return
    val next = (index + offset + tabs.size) % tabs.size
    selectTab(tabs[next].id)
  }

  /**
   * Fetch a file through the proxy and hand it to the system picker.
   *
   * The content view resolves `.localhost` internally, so this process asks for the
   * same URL by name (`/__ncc/fetch?u=…`) rather than trying to resolve it.
   */
  private fun startDownload(vhostUrl: String, mimeType: String?) {
    val port = Uri.parse(vhostUrl).port
    if (port <= 0) {
      toast("Download failed: the proxy port is unknown")
      return
    }

    val name = vhostUrl.substringAfterLast('/').substringBefore('?').ifEmpty { "download" }
    toast("Downloading $name…")

    Thread {
      val temp = File(cacheDir, "download-${System.currentTimeMillis()}")
      val fetched = try {
        val encoded = URLEncoder.encode(vhostUrl, "UTF-8")
        val connection =
          URL("http://127.0.0.1:$port/__ncc/fetch?u=$encoded").openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.inputStream.use { input ->
          temp.outputStream().use { output -> input.copyTo(output) }
        }
        connection.disconnect()
        true
      } catch (error: Exception) {
        temp.delete()
        false
      }

      runOnUiThread {
        if (!fetched) {
          toast("Download failed")
          return@runOnUiThread
        }

        pendingDownload = temp
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = mimeType ?: "application/octet-stream"
          putExtra(Intent.EXTRA_TITLE, name)
        }
        saveDownload.launch(intent)
      }
    }.apply { isDaemon = true }.start()
  }

  private fun toast(message: String) {
    Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
  }

  private fun onTabEvent(payload: JSONObject) {
    val tab = tabs.firstOrNull { it.id == payload.optString("tab") }
    emitToShell("window.__nccContent", payload)

    // Title changes are what the bar shows, so the tab list follows a load.
    if (payload.optString("type") == "loaded" && tab != null) emitTabs(false)
  }

  private fun emitTabs(captureActiveTab: Boolean) {
    if (captureActiveTab) {
      captureActive { emitTabs(false) }
      return
    }

    val array = JSONArray()
    for (tab in tabs) {
      val entry = JSONObject()
        .put("id", tab.id)
        .put("title", tab.title ?: "")
        .put("url", tab.currentUrl ?: "")
        .put("active", tab.id == activeId)
      tab.thumbnail?.let { entry.put("thumbnail", it) }
      array.put(entry)
    }

    val payload = JSONObject().put("tabs", array).put("active", activeId ?: "")
    emitToShell("window.__nccTabs", payload)
  }

  private fun emitToShell(function: String, payload: JSONObject) {
    val view = shell ?: return
    val json = payload.toString()
    view.post {
      view.evaluateJavascript("$function && $function($json)", null)
    }
  }

  private fun tabsJson(): String {
    val array = JSONArray()
    for (tab in tabs) {
      array.put(
        JSONObject()
          .put("id", tab.id)
          .put("title", tab.title ?: "")
          .put("url", tab.currentUrl ?: "")
          .put("active", tab.id == activeId),
      )
    }
    return array.toString()
  }

  inner class Bridge {
    @JavascriptInterface
    fun open(url: String) {
      runOnUiThread { openTab(url, reuseActive = true) }
    }

    @JavascriptInterface
    fun openNew(url: String) {
      runOnUiThread { openTab(url, reuseActive = false) }
    }

    @JavascriptInterface
    fun select(id: String) {
      runOnUiThread { selectTab(id) }
    }

    @JavascriptInterface
    fun closeTab(id: String) {
      runOnUiThread { closeTab(id) }
    }

    @JavascriptInterface
    fun closeActive() {
      runOnUiThread { closeTab(activeId) }
    }

    @JavascriptInterface
    fun next() {
      runOnUiThread { step(1) }
    }

    @JavascriptInterface
    fun prev() {
      runOnUiThread { step(-1) }
    }

    @JavascriptInterface
    fun tabs(): String = tabsJson()

    @JavascriptInterface
    fun capture() {
      runOnUiThread { emitTabs(true) }
    }

    @JavascriptInterface
    fun back() {
      runOnUiThread { active()?.back() }
    }

    @JavascriptInterface
    fun reload() {
      runOnUiThread { active()?.reload() }
    }

    @JavascriptInterface
    fun clearWebCache() {
      runOnUiThread {
        for (tab in tabs) tab.clearCache()
      }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
      runOnUiThread {
        try {
          startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        } catch (error: Exception) {
          // No handler installed; nothing else to try.
        }
      }
    }

    @JavascriptInterface
    fun expand(value: Boolean) {
      runOnUiThread { setExpanded(value) }
    }

    @JavascriptInterface
    fun setBarPosition(position: String) {
      runOnUiThread { applyBarPosition(position) }
    }
  }

  override fun onDestroy() {
    for (tab in tabs) tab.destroy()
    tabs.clear()
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
