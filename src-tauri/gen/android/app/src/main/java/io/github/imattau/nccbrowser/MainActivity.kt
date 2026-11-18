package io.github.imattau.nccbrowser

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebStorage
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
 *                  `.back()`, `.forward()`, `.reload()`, `.stop()`, `.expand(bool)`,
 *                  `.find(q)`, `.findNext(bool)`, `.clearFind()`, `.share(text)`,
 *                  `.copy(text)`, `.setDesktopMode(bool)`, `.setBarPosition(…)`
 *   tabs → shell   `window.__nccContent({...})`, `window.__nccTabs({...})`
 *   back → shell   `window.__nccBack()` — `true` when the shell consumed the gesture
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

  /** The proxy's port, as reported by the shell. Clearnet pages cannot reveal it. */
  private var proxyPortNumber = 0

  /** The private listener's port. A different port is a different origin, so private
   * tabs get their own storage instead of sharing the normal one. */
  private var privatePortNumber = 0

  /** The onion listener's port. Separate again, so a Tor tab's storage is its own and
   * none of the NCC cache is reachable from it. */
  private var torPortNumber = 0
  private var pendingDownload: Pair<File, String>? = null
  private lateinit var downloads: Downloads

  /**
   * Saving goes through the system picker: no storage permission, and the user chooses
   * where a file lands.
   */
  private val saveDownload =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val pending = pendingDownload
      pendingDownload = null
      val target = result.data?.data

      if (pending == null) return@registerForActivityResult

      val (file, id) = pending
      if (result.resultCode != Activity.RESULT_OK || target == null) {
        downloads.finish(id, "cancelled")
        file.delete()
        return@registerForActivityResult
      }

      try {
        file.inputStream().use { input ->
          contentResolver.openOutputStream(target)?.use { output -> input.copyTo(output) }
        }
        downloads.finish(id, "saved")
        toast("Saved")
      } catch (error: Exception) {
        downloads.finish(id, "failed")
        toast("Could not save: ${error.message}")
      } finally {
        file.delete()
      }
    }
  /**
   * The vault's unlock prompt. Android's own device-credential screen is used rather
   * than a biometric library: one prompt, nothing new to ship, and it falls back to
   * the PIN or pattern the device already trusts.
   */
  private val confirmDevice =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      emitToShellRaw(
        "window.__nccDeviceCredential",
        if (result.resultCode == Activity.RESULT_OK) "true" else "false",
      )
    }
  private var activeId: String? = null
  private var nextTabId = 1

  /**
   * A link another app handed us (we are a registered browser). The shell takes it once
   * its saved tabs are back, or immediately when it is already running.
   */
  private var pendingLink: String? = null

  private fun captureLink(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    if (uri.scheme != "http" && uri.scheme != "https") return
    pendingLink = uri.toString()
    // Handled: a later configuration change must not replay it.
    intent.data = null
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureLink(intent)
    if (pendingLink != null) {
      shell?.evaluateJavascript("window.__nccOpenLink && window.__nccOpenLink()", null)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    installCrashReporter()
    if (savedInstanceState == null) captureLink(intent)

    // Anything an earlier run left in the private or Tor sessions goes first, before a
    // tab can load them.
    Profiles.reset()

    barHeight = (56 * resources.displayMetrics.density).toInt()
    downloads = Downloads(this).also { store ->
      store.onChange = { json -> emitToShellRaw("window.__nccDownloads", json) }
    }

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
      // The keyboard lifts the whole column, so a bottom strip (find in page) and the
      // address field stay above it instead of being covered.
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(columnView)

    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // A fullscreen video comes first: back leaves it, not the page.
        if (active()?.hideFullscreen() == true) return
        // Panels, find-in-page and the signer prompt belong to the shell; ask it first
        // so back closes the sheet in front instead of navigating the page behind it.
        val view = shell
        if (view == null) {
          leave()
          return
        }
        view.evaluateJavascript("window.__nccBack ? window.__nccBack() : false") { handled ->
          if (handled != "true") navigateBack()
        }
      }
    }
    backCallback = callback
    onBackPressedDispatcher.addCallback(this, callback)

    chromeView.addJavascriptInterface(Bridge(), "NccContent")

    chromeView.evaluateJavascript("window.__nccContentReady && window.__nccContentReady()", null)
  }

  /**
   * Keep the last crash where it can be read.
   *
   * Alpha builds crash in ways that only show up on a device, and asking someone to
   * attach a debugger mid-session is not a workflow. The trace is written to the app's
   * own files directory and its first line is shown on the next launch, which is
   * enough to know what to look at.
   */
  private fun installCrashReporter() {
    val previous = File(filesDir, "last-crash.txt")
    if (previous.exists()) {
      val first = previous.readLines().firstOrNull { it.isNotBlank() }
      toast("Last crash: ${first ?: "unknown"}")
      previous.delete()
    }

    val system = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      try {
        File(filesDir, "last-crash.txt").writeText(
          buildString {
            appendLine(error.toString())
            appendLine("thread: ${thread.name}")
            appendLine(error.stackTraceToString())
          },
        )
      } catch (failure: Throwable) {
        // Reporting a crash must not become a second one.
      }
      system?.uncaughtException(thread, error)
    }
  }

  private fun active(): ContentSurface? = tabs.firstOrNull { it.id == activeId }

  /** Page history, then close the tab, then leave the app. */
  private fun navigateBack() {
    if (active()?.back() == true) return
    if (tabs.isNotEmpty()) {
      closeTab(activeId)
      return
    }
    leave()
  }

  private fun leave() {
    backCallback?.isEnabled = false
    onBackPressedDispatcher.onBackPressed()
  }

  private fun setExpanded(value: Boolean) {
    // A tab can only be captured while it is still on screen, and the switcher and the
    // blurred sheet backdrop both want a fresh capture of it. Hiding it first would
    // copy the shell's own pixels instead.
    val current = active()
    if (value && !expanded && current != null && current.isOpen) {
      captureActive {
        applyExpanded(true)
        emitTabs(false)
      }
      return
    }
    applyExpanded(value)
  }

  private fun applyExpanded(value: Boolean) {
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

  private fun openTab(
    url: String,
    reuseActive: Boolean,
    isPrivate: Boolean = false,
    isTor: Boolean = false,
  ): Boolean {
    if (reuseActive) {
      val current = active()
      if (current != null &&
        current.isPrivate == isPrivate &&
        current.isTor == isTor &&
        current.open(url)
      ) {
        setExpanded(false)
        emitTabs(false)
        return true
      }
    }

    captureActive {
      val tab = ContentSurface(
        "tab-${nextTabId++}",
        isPrivate,
        isTor,
        contentHost ?: return@captureActive,
        {
          when {
            isTor -> torPortNumber
            isPrivate -> privatePortNumber
            else -> proxyPortNumber
          }
        },
        ::onTabEvent,
        ::startDownload,
        { target -> openTab(target, reuseActive = false, isPrivate = isPrivate, isTor = isTor) },
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

  /**
   * A tab from the last run. Only the active one loads; the rest wait to be picked.
   * The shell restores normal tabs only: private and Tor tabs are never written down.
   */
  private fun restoreTab(url: String, savedTitle: String?, makeActive: Boolean) {
    val host = contentHost ?: return
    val tab = ContentSurface(
      "tab-${nextTabId++}",
      false,
      false,
      host,
      { proxyPortNumber },
      ::onTabEvent,
      ::startDownload,
      { target -> openTab(target, reuseActive = false) },
    )
    if (!tab.accepts(url)) {
      tab.destroy()
      return
    }
    tab.park(url, savedTitle)
    tabs.add(tab)
    if (makeActive || activeId == null) {
      active()?.hide()
      activeId = tab.id
      tab.show()
      setExpanded(false)
    }
    emitTabs(false)
  }

  /**
   * Drop what one site stored on this device: its cookies and its local storage,
   * IndexedDB and service workers, then reload the tabs showing it.
   *
   * A site is its own host and port, so another service of the same identity is a
   * different site and is left alone. Cookies cannot be listed, only read for a URL, so
   * each one is expired on the paths a page could have set it for. Cookies ignore the
   * port, so a private tab and a normal tab on the same host share a jar: clearing from
   * either clears both.
   */
  private fun clearSiteDataFor(url: String) {
    val uri = Uri.parse(url)
    val host = uri.host ?: return
    val scheme = uri.scheme ?: return
    val authority = uri.authority ?: return
    val origin = "$scheme://$authority"

    // The port says which listener served the page, and so which session holds its data.
    val profile = when {
      torPortNumber > 0 && uri.port == torPortNumber -> Profiles.TOR
      privatePortNumber > 0 && uri.port == privatePortNumber -> Profiles.PRIVATE
      else -> null
    }
    val cookies = Profiles.cookieManager(profile)
    var cleared = 0
    val names = cookies.getCookie(origin)
      ?.split(";")
      ?.map { it.substringBefore("=").trim() }
      ?.filter { it.isNotEmpty() }
      ?: emptyList()

    val segments = (uri.path ?: "/").split("/").filter { it.isNotEmpty() }
    val paths = mutableListOf("/")
    var built = ""
    for (segment in segments) {
      built += "/$segment"
      paths.add(built)
    }

    for (name in names) {
      for (path in paths) {
        cookies.setCookie(origin, "$name=; Max-Age=0; Path=$path")
        cookies.setCookie(origin, "$name=; Max-Age=0; Path=$path; Domain=$host")
      }
      cleared++
    }
    cookies.flush()

    Profiles.webStorage(profile).deleteOrigin(origin)

    for (tab in tabs) {
      if (Uri.parse(tab.currentUrl ?: "").authority == authority) tab.reload()
    }

    emitToShell(
      "window.__nccContent",
      JSONObject().put("type", "cleared").put("url", url).put("cookies", cleared),
    )
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

    // The last private or Tor tab takes its session with it.
    if (target.isTor && tabs.none { it.isTor }) {
      target.clearProtectionSession()
      Profiles.wipe(Profiles.TOR)
    }
    if (target.isPrivate && tabs.none { it.isPrivate }) {
      target.clearProtectionSession()
      Profiles.wipe(Profiles.PRIVATE)
    }

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
   * Fetch a file and hand it to the system picker.
   *
   * A virtual host only resolves inside the content WebView, so those are fetched by
   * the proxy (`/__ncc/fetch?u=…`). A clearnet URL needs no help: this process can
   * open it directly.
   */
  private fun startDownload(url: String, mimeType: String?, contentDisposition: String?) {
    val parsed = Uri.parse(url)
    val host = parsed.host?.lowercase() ?: ""
    val throughProxy = host.endsWith(".localhost")
    // The vhost URL already names the listener that served it, which is how a private
    // or Tor tab's download comes from the listener that tab uses.
    val port = if (throughProxy) parsed.port else proxyPortNumber
    // A private or Tor tab's download keeps its name but not its address: the list is
    // a file on disk, and what those tabs fetched is not something to leave in it.
    val fromEphemeralTab = throughProxy &&
      ((privatePortNumber > 0 && parsed.port == privatePortNumber) ||
        (torPortNumber > 0 && parsed.port == torPortNumber))

    if (throughProxy && port <= 0) {
      toast("Download failed: the proxy port is unknown")
      return
    }

    val name = filenameFor(contentDisposition, url, mimeType)
    toast("Downloading $name…")

    Thread {
      val temp = File(cacheDir, "download-${System.currentTimeMillis()}")
      val id = downloads.start(name, if (fromEphemeralTab) "" else url, -1)

      val fetched = try {
        val source = if (throughProxy) {
          val encoded = URLEncoder.encode(url, "UTF-8")
          "http://127.0.0.1:$port/__ncc/fetch?u=$encoded"
        } else {
          url
        }
        val connection = URL(source).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000

        var read = 0L
        connection.inputStream.use { input ->
          temp.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            var lastReport = 0L
            while (true) {
              val count = input.read(buffer)
              if (count <= 0) break
              output.write(buffer, 0, count)
              read += count
              // Report at most a few times a second; the list does not need more.
              val now = System.currentTimeMillis()
              if (now - lastReport > 250) {
                lastReport = now
                downloads.progress(id, read)
              }
            }
          }
        }
        downloads.progress(id, read)
        connection.disconnect()
        true
      } catch (error: Exception) {
        temp.delete()
        false
      }

      runOnUiThread {
        if (!fetched) {
          downloads.finish(id, "failed")
          toast("Download failed")
          return@runOnUiThread
        }

        pendingDownload = temp to id
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = mimeType ?: "application/octet-stream"
          putExtra(Intent.EXTRA_TITLE, name)
        }
        saveDownload.launch(intent)
      }
    }.apply { isDaemon = true }.start()
  }

  /** `Content-Disposition` when the server names the file, otherwise the URL's last segment. */
  private fun filenameFor(disposition: String?, url: String, mimeType: String?): String {
    val candidate = disposition?.let { value ->
      val encoded = Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(value)
      val quoted = Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(value)
      (encoded ?: quoted)?.groupValues?.getOrNull(1)?.trim()?.trim('"')
    }

    val raw = candidate?.takeIf { it.isNotBlank() }
      ?: Uri.parse(url).lastPathSegment?.substringBefore('?')?.takeIf { it.isNotBlank() }
      ?: "download"

    // Whatever the server says, a filename is one path segment.
    val safe = raw.replace(Regex("[\\\\/:*?\"<>|]"), "-").trim()
    return if (safe.isEmpty()) {
      mimeType?.substringAfterLast('/')?.let { "download.$it" } ?: "download"
    } else {
      safe
    }
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
        .put("canGoBack", tab.canGoBack())
        .put("canGoForward", tab.canGoForward())
        .put("desktop", tab.desktopMode)
        .put(
          "kind",
          when {
            tab.isTor -> "tor"
            tab.isPrivate -> "private"
            else -> "normal"
          },
        )
      tab.thumbnail?.let { entry.put("thumbnail", it) }
      array.put(entry)
    }

    val payload = JSONObject().put("tabs", array).put("active", activeId ?: "")
    emitToShell("window.__nccTabs", payload)
  }

  private fun emitToShell(function: String, payload: JSONObject) {
    emitToShellRaw(function, payload.toString())
  }

  private fun emitToShellRaw(function: String, json: String) {
    val view = shell ?: return
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
    /** The link another app asked us to open, once. */
    @JavascriptInterface
    fun takeLink(): String? {
      val link = pendingLink
      pendingLink = null
      return link
    }

    @JavascriptInterface
    fun open(url: String?) {
      val target = url ?: return
      runOnUiThread { openTab(target, reuseActive = true) }
    }

    @JavascriptInterface
    fun openNew(url: String?) {
      val target = url ?: return
      runOnUiThread { openTab(target, reuseActive = false) }
    }

    @JavascriptInterface
    fun openPrivate(url: String?) {
      val target = url ?: return
      runOnUiThread { openTab(target, reuseActive = true, isPrivate = true) }
    }

    @JavascriptInterface
    fun openNewPrivate(url: String?) {
      val target = url ?: return
      runOnUiThread { openTab(target, reuseActive = false, isPrivate = true) }
    }

    @JavascriptInterface
    fun openTor(url: String?) {
      val target = url ?: return
      runOnUiThread { openTab(target, reuseActive = true, isTor = true) }
    }

    @JavascriptInterface
    fun openNewTor(url: String?) {
      val target = url ?: return
      runOnUiThread { openTab(target, reuseActive = false, isTor = true) }
    }

    @JavascriptInterface
    fun select(id: String?) {
      val target = id ?: return
      runOnUiThread { selectTab(target) }
    }

    @JavascriptInterface
    fun closeTab(id: String?) {
      // Qualified on purpose: an unqualified call resolves to this method, and the
      // bridge would post itself forever instead of closing anything.
      runOnUiThread { this@MainActivity.closeTab(id) }
    }

    @JavascriptInterface
    fun closeActive() {
      runOnUiThread { this@MainActivity.closeTab(activeId) }
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
    fun downloads(): String = downloads.json()

    @JavascriptInterface
    fun clearDownloads() {
      runOnUiThread { downloads.clear() }
    }

    @JavascriptInterface
    fun capture() {
      runOnUiThread { emitTabs(true) }
    }

    @JavascriptInterface
    fun restoreTab(url: String?, title: String?, active: Boolean) {
      val target = url ?: return
      // Qualified for the same reason as closeTab above.
      runOnUiThread { this@MainActivity.restoreTab(target, title, active) }
    }

    /** The shell learns the port from the Rust side; the tabs need it for links and
     * downloads from pages that do not carry it in their URL. */
    @JavascriptInterface
    fun setProxyPort(port: Int?) {
      val value = port ?: return
      runOnUiThread { proxyPortNumber = value }
    }

    @JavascriptInterface
    fun setPrivateProxyPort(port: Int?) {
      val value = port ?: return
      runOnUiThread { privatePortNumber = value }
    }

    @JavascriptInterface
    fun setTorProxyPort(port: Int?) {
      val value = port ?: return
      runOnUiThread { torPortNumber = value }
    }

    /** The strip's arrow: same path as the system gesture, so the two cannot drift. */
    @JavascriptInterface
    fun navigateBack() {
      runOnUiThread { this@MainActivity.navigateBack() }
    }

    /** True when the system navigates by swipe gestures (Android 10+, mode 2). */
    @JavascriptInterface
    fun isGestureNavigation(): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
      return try {
        android.provider.Settings.Secure.getInt(contentResolver, "navigation_mode", 0) == 2
      } catch (_: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun back() {
      runOnUiThread { active()?.back() }
    }

    @JavascriptInterface
    fun forward() {
      runOnUiThread {
        active()?.forward()
      }
    }

    @JavascriptInterface
    fun reload() {
      runOnUiThread { active()?.reload() }
    }

    @JavascriptInterface
    fun stop() {
      runOnUiThread { active()?.stop() }
    }

    @JavascriptInterface
    fun find(query: String?) {
      val text = query ?: return
      runOnUiThread { active()?.find(text) }
    }

    @JavascriptInterface
    fun findNext(forward: Boolean) {
      runOnUiThread { active()?.findNext(forward) }
    }

    @JavascriptInterface
    fun clearFind() {
      runOnUiThread { active()?.clearFind() }
    }

    @JavascriptInterface
    fun setDesktopMode(enabled: Boolean) {
      runOnUiThread {
        active()?.setDesktopMode(enabled)
        emitTabs(false)
      }
    }

    @JavascriptInterface
    fun share(text: String?) {
      val value = text ?: return
      runOnUiThread {
        val send = Intent(Intent.ACTION_SEND)
          .setType("text/plain")
          .putExtra(Intent.EXTRA_TEXT, value)
        try {
          startActivity(Intent.createChooser(send, null))
        } catch (error: Exception) {
          // No share target installed.
        }
      }
    }

    @JavascriptInterface
    fun fillLogin(tabId: String?, username: String?, password: String?) {
      val id = tabId ?: return
      val secret = password ?: return
      val user = username ?: ""
      runOnUiThread { tabs.firstOrNull { it.id == id }?.fillLogin(user, secret) }
    }

    /** Write-only: the page-triggered path must never be able to read a password. */
    @JavascriptInterface
    fun copySecret(text: String?, label: String?) {
      val value = text ?: return
      runOnUiThread {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(label ?: "password", value))
        toast(label ?: "Copied")
        // Best effort: Android 10+ may ignore a background clipboard write, which is
        // also why the copy is only made while the app is in front.
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val current = clipboard.primaryClip?.getItemAt(0)?.text?.toString()
            if (current == value) {
              clipboard.clearPrimaryClip()
            }
          }
        }, 30_000)
      }
    }

    @JavascriptInterface
    fun unlockWithDeviceCredential() {
      runOnUiThread {
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (!keyguard.isDeviceSecure) {
          // No lock to confirm against; the app itself is the only barrier, and the
          // vault screen says so.
          emitToShellRaw("window.__nccDeviceCredential", "true")
          return@runOnUiThread
        }
        val intent = keyguard.createConfirmDeviceCredentialIntent(
          "Unlock passwords",
          "Confirm it is you to open the vault.",
        )
        if (intent == null) {
          emitToShellRaw("window.__nccDeviceCredential", "false")
          return@runOnUiThread
        }
        try {
          confirmDevice.launch(intent)
        } catch (error: Exception) {
          emitToShellRaw("window.__nccDeviceCredential", "false")
        }
      }
    }

    @JavascriptInterface
    fun copy(text: String?) {
      val value = text ?: return
      runOnUiThread {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("address", value))
        Toast.makeText(this@MainActivity, "Address copied", Toast.LENGTH_SHORT).show()
      }
    }

    /** Whether private and Tor tabs get their own cookies and storage. */
    @JavascriptInterface
    fun profilesSupported(): Boolean = Profiles.supported()

    @JavascriptInterface
    fun clearSiteData(url: String?) {
      val target = url ?: return
      // Qualified like closeTab: the bridge method has the same name.
      runOnUiThread { this@MainActivity.clearSiteDataFor(target) }
    }

    @JavascriptInterface
    fun clearWebCache() {
      runOnUiThread {
        for (tab in tabs) tab.clearCache()
      }
    }

    @JavascriptInterface
    fun openExternal(url: String?) {
      val target = url ?: return
      runOnUiThread {
        try {
          startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(target)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
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
    fun setBarPosition(position: String?) {
      val value = position ?: return
      runOnUiThread { applyBarPosition(value) }
    }
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    PermissionRequestBridge.resolve(requestCode, grantResults)
  }

  override fun onDestroy() {
    for (tab in tabs) tab.destroy()
    tabs.clear()
    Profiles.wipe(Profiles.PRIVATE)
    Profiles.wipe(Profiles.TOR)
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
