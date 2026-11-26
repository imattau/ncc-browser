package io.github.imattau.nccbrowser

import java.net.URI
import java.net.URLDecoder

/**
 * What a long press offers.
 *
 * The rules that matter are about where an address may go: a private tab never offers a
 * way into a normal one, and a Tor tab offers nothing that would fetch outside Tor. No
 * Android types, so they can be tested directly.
 */
object LinkMenu {
  enum class TabKind { NORMAL, PRIVATE, TOR }

  enum class Action {
    /** A new tab of the same kind, behind this one. */
    OPEN_BACKGROUND,
    /** From a normal tab into a private one, which is then shown. */
    OPEN_PRIVATE,
    /** The shell picks the Tor address and shows the new tab. */
    OPEN_TOR,
    COPY_ADDRESS,
    SHARE,
    /** The shell's own screen, where nothing is posted until the person says so. */
    SHARE_NOSTR,
    DOWNLOAD,
    COPY_TEXT,
    /** Hand a mailto: or tel: link to another app. */
    OPEN_APP,
  }

  data class Item(val action: Action, val label: String, val target: String)

  /** `heading` is the address being acted on; sections are drawn with a line between. */
  data class Menu(val heading: String, val isImage: Boolean, val sections: List<List<Item>>)

  /** What this tab can reach. A port of zero means that listener is not running. */
  data class Routes(val kind: TabKind, val privatePort: Int, val torPort: Int)

  /** Null when there is nothing to offer, which leaves the press to the system. */
  fun build(link: String?, image: String?, routes: Routes): Menu? {
    val address = link?.trim()?.takeIf { it.isNotEmpty() }?.let { unblocked(it) }
    val picture = image?.trim()?.takeIf { it.isNotEmpty() }?.let { unblocked(it) }

    val linkItems = address?.let { linkItems(it, routes) }.orEmpty()
    val imageItems = picture?.let { imageItems(it, routes, linked = linkItems.isNotEmpty()) }.orEmpty()
    val sections = listOf(linkItems, imageItems).filter { it.isNotEmpty() }
    if (sections.isEmpty()) return null

    val onlyImage = linkItems.isEmpty()
    return Menu(if (onlyImage) picture!! else address!!, onlyImage, sections)
  }

  /** A Tor page's clearnet references point at the proxy's refusal; act on the real one. */
  fun unblocked(url: String): String {
    val uri = parse(url) ?: return url
    if (uri.rawPath != "/__ncc/blocked" || !isVirtualHost(uri.host)) return url
    val original = uri.rawQuery?.split('&')?.firstOrNull { it.startsWith("u=") } ?: return url
    return runCatching { URLDecoder.decode(original.substring(2), "UTF-8") }.getOrDefault(url)
  }

  private fun linkItems(url: String, routes: Routes): List<Item> {
    return when (scheme(url)) {
      "mailto" -> {
        val to = url.substring(7).substringBefore('?')
        listOf(Item(Action.OPEN_APP, "Send email", url), Item(Action.COPY_TEXT, "Copy email address", to))
      }
      "tel" -> listOf(Item(Action.OPEN_APP, "Call", url), Item(Action.COPY_TEXT, "Copy number", url.substring(4)))
      "http", "https", "ncc", "nsite" -> buildList {
        addAll(openItems(url, routes, "Open"))
        add(Item(Action.COPY_ADDRESS, "Copy link", url))
        add(Item(Action.SHARE, "Share link", url))
        // A public post under the person's name: never from a private or Tor tab.
        if (routes.kind == TabKind.NORMAL) add(Item(Action.SHARE_NOSTR, "Share to Nostr", url))
        if (canDownload(url, routes)) add(Item(Action.DOWNLOAD, "Download link", url))
      }
      // javascript:, intent: and the rest do nothing useful outside the page.
      else -> emptyList()
    }
  }

  private fun imageItems(url: String, routes: Routes, linked: Boolean): List<Item> {
    // An image written into the page can be saved, but has no address worth keeping.
    if (url.startsWith("data:image/", ignoreCase = true)) {
      return listOf(Item(Action.DOWNLOAD, "Download image", url))
    }
    val kind = scheme(url)
    if (kind != "http" && kind != "https") return emptyList()
    return buildList {
      val open = openItems(url, routes, "Open image").firstOrNull()
      if (open != null) add(open)
      if (canDownload(url, routes)) add(Item(Action.DOWNLOAD, "Download image", url))
      // Under a link the menu is already long, and "Copy link" is the one wanted.
      if (!linked) add(Item(Action.COPY_ADDRESS, "Copy image address", url))
    }
  }

  private fun openItems(url: String, routes: Routes, verb: String): List<Item> {
    val torOpen = "$verb in new Tor tab"
    if (isOnion(url)) {
      return if (routes.torPort > 0) listOf(Item(Action.OPEN_TOR, torOpen, url)) else emptyList()
    }
    return when (routes.kind) {
      TabKind.TOR -> when {
        onTorListener(url, routes) || scheme(url) == "ncc" || scheme(url) == "nsite" ->
          listOf(Item(Action.OPEN_BACKGROUND, torOpen, url))
        // Not yet a Tor address; only https can be made into one.
        scheme(url) == "https" && routes.torPort > 0 -> listOf(Item(Action.OPEN_TOR, torOpen, url))
        else -> emptyList()
      }
      TabKind.PRIVATE -> listOf(Item(Action.OPEN_BACKGROUND, "$verb in new private tab", url))
      TabKind.NORMAL -> buildList {
        add(Item(Action.OPEN_BACKGROUND, "$verb in new tab", url))
        if (routes.privatePort > 0) add(Item(Action.OPEN_PRIVATE, "$verb in private tab", url))
      }
    }
  }

  private fun canDownload(url: String, routes: Routes): Boolean {
    val kind = scheme(url)
    if (kind != "http" && kind != "https") return false
    if (isOnion(url)) return false
    // The app process fetches downloads itself. For a Tor tab only an address that
    // goes back through the Tor listener is safe to hand it.
    return routes.kind != TabKind.TOR || onTorListener(url, routes)
  }

  private fun onTorListener(url: String, routes: Routes): Boolean {
    val uri = parse(url) ?: return false
    return routes.torPort > 0 && uri.port == routes.torPort && isVirtualHost(uri.host)
  }

  /**
   * The private listener serves the same virtual hosts on its own port. Read from the
   * text: a URL left unchanged here would load through the normal listener.
   */
  fun onPort(url: String, port: Int): String {
    val start = url.indexOf("://")
    if (port <= 0 || start < 0) return url
    val authority = url.substring(start + 3).takeWhile { it != '/' && it != '?' && it != '#' }
    val name = authority.substringBeforeLast(':')
    if (name == authority || !isVirtualHost(name)) return url
    return url.substring(0, start + 3) + name + ":" + port + url.substring(start + 3 + authority.length)
  }

  private fun isVirtualHost(host: String?): Boolean = host?.lowercase()?.endsWith(".localhost") == true

  private fun isOnion(url: String): Boolean = host(url)?.endsWith(".onion") == true

  /** Read from the text: `URI` gives up on hosts and paths that browsers accept. */
  private fun host(url: String): String? {
    val start = url.indexOf("://")
    if (start < 0) return null
    val authority = url.substring(start + 3).takeWhile { it != '/' && it != '?' && it != '#' }
    return authority.substringAfterLast('@').substringBefore(':').lowercase().trimEnd('.')
  }

  private fun scheme(url: String): String = url.substringBefore(':', "").lowercase()

  /** Only the authority, path and query are read, so the rest need not parse. */
  private fun parse(url: String): URI? =
    runCatching { URI(url.substringBefore('#').replace(" ", "%20").replace("|", "%7C")) }.getOrNull()
}
