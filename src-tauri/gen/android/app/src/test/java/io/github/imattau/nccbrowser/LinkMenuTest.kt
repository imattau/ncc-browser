package io.github.imattau.nccbrowser

import io.github.imattau.nccbrowser.LinkMenu.Action
import io.github.imattau.nccbrowser.LinkMenu.Routes
import io.github.imattau.nccbrowser.LinkMenu.TabKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkMenuTest {
  private val normal = Routes(TabKind.NORMAL, privatePort = 5001, torPort = 5002)
  private val private = normal.copy(kind = TabKind.PRIVATE)
  private val tor = normal.copy(kind = TabKind.TOR)

  private fun labels(link: String?, image: String?, routes: Routes) =
    LinkMenu.build(link, image, routes)?.sections?.map { section -> section.map { it.label } }

  private fun actions(link: String?, image: String?, routes: Routes) =
    LinkMenu.build(link, image, routes)?.sections?.flatten()?.map { it.action }.orEmpty()

  @Test
  fun aLinkInANormalTab() {
    assertEquals(
      listOf(listOf("Open in new tab", "Open in private tab", "Copy link", "Share link", "Share to Nostr", "Download link")),
      labels("https://example.com/a?b=1#c", null, normal),
    )
  }

  @Test
  fun noPrivateTabIsOfferedWithoutItsListener() {
    assertEquals(
      listOf(Action.OPEN_BACKGROUND, Action.COPY_ADDRESS, Action.SHARE, Action.SHARE_NOSTR, Action.DOWNLOAD),
      actions("https://example.com/", null, normal.copy(privatePort = 0)),
    )
  }

  @Test
  fun aPrivateTabNeverOffersANormalOne() {
    assertEquals(
      listOf(listOf("Open in new private tab", "Copy link", "Share link", "Download link")),
      labels("https://example.com/", null, private),
    )
  }

  @Test
  fun nccAndNsiteLinksAreNotDownloads() {
    for (link in listOf("ncc://abc/web", "nsite://abc/blog")) {
      assertEquals(
        listOf(Action.OPEN_BACKGROUND, Action.OPEN_PRIVATE, Action.COPY_ADDRESS, Action.SHARE, Action.SHARE_NOSTR),
        actions(link, null, normal),
      )
    }
  }

  @Test
  fun onionsOnlyOpenThroughTor() {
    for (routes in listOf(normal, private, tor)) {
      assertEquals(
        listOf(Action.OPEN_TOR),
        actions("http://abcdefgh.onion/page", null, routes).filter { it.name.startsWith("OPEN") },
      )
      assert(Action.DOWNLOAD !in actions("http://abcdefgh.onion/page", null, routes))
    }
    assert(Action.OPEN_TOR !in actions("http://abcdefgh.onion/", null, normal.copy(torPort = 0)))
  }

  @Test
  fun onlyANormalTabCanPostALinkPublicly() {
    for (link in listOf("https://example.com/", "ncc://abc/web", "http://abcdefgh.onion/")) {
      assert(Action.SHARE_NOSTR in actions(link, null, normal)) { link }
      assert(Action.SHARE_NOSTR !in actions(link, null, private)) { link }
      assert(Action.SHARE_NOSTR !in actions(link, null, tor)) { link }
    }
    assert(Action.SHARE_NOSTR !in actions(null, "https://example.com/cat.png", normal))
    assert(Action.SHARE_NOSTR !in actions("mailto:a@example.com", null, normal))
  }

  @Test
  fun aTorTabDownloadsOnlyThroughItsOwnListener() {
    val through = "http://abc.onion.localhost:5002/file.zip"
    assertEquals(
      listOf(Action.OPEN_BACKGROUND, Action.COPY_ADDRESS, Action.SHARE, Action.DOWNLOAD),
      actions(through, null, tor),
    )
    // The app process would fetch any of these without Tor.
    for (direct in listOf(
      "https://example.com/file.zip",
      "http://example.com/file.zip",
      "http://abc.localhost:5000/file.zip",
      "http://evil.example:5002/file.zip",
      "http://abc.onion.localhost.evil.example:5002/file.zip",
    )) {
      assert(Action.DOWNLOAD !in actions(direct, direct, tor)) { direct }
      assert(Action.OPEN_BACKGROUND !in actions(direct, null, tor)) { direct }
    }
  }

  @Test
  fun aTorPagesRefusedLinkActsOnTheRealAddress() {
    val menu = LinkMenu.build(
      "http://abc.onion.localhost:5002/__ncc/blocked?u=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1",
      null,
      tor,
    )!!
    assertEquals("https://example.com/a?b=1", menu.heading)
    assertEquals(listOf(Action.OPEN_TOR, Action.COPY_ADDRESS, Action.SHARE), menu.sections.flatten().map { it.action })
  }

  @Test
  fun aSiteCannotDressUpTheRefusalPath() {
    val link = "https://example.com/__ncc/blocked?u=https%3A%2F%2Fbank.example"
    assertEquals(link, LinkMenu.unblocked(link))
  }

  @Test
  fun aPicture() {
    assertEquals(
      listOf(listOf("Open image in new tab", "Download image", "Copy image address")),
      labels(null, "https://example.com/cat.png", normal),
    )
  }

  @Test
  fun aLinkedPictureOffersBothWithoutRepeatingCopy() {
    assertEquals(
      listOf(
        listOf("Open in new tab", "Open in private tab", "Copy link", "Share link", "Share to Nostr", "Download link"),
        listOf("Open image in new tab", "Download image"),
      ),
      labels("https://example.com/page", "https://example.com/cat.png", normal),
    )
  }

  @Test
  fun aPictureWrittenIntoThePageCanOnlyBeSaved() {
    assertEquals(listOf(Action.DOWNLOAD), actions(null, "data:image/png;base64,AAAA", tor))
    assertNull(LinkMenu.build(null, "blob:https://example.com/1", normal))
  }

  @Test
  fun emailAndPhone() {
    val mail = LinkMenu.build("mailto:a@example.com?subject=hi", null, normal)!!
    assertEquals(listOf("Send email", "Copy email address"), mail.sections.single().map { it.label })
    assertEquals("a@example.com", mail.sections.single()[1].target)
    assertEquals(listOf(listOf("Call", "Copy number")), labels("tel:+61000000000", null, tor))
  }

  @Test
  fun scriptsAndOtherSchemesOfferNothing() {
    for (link in listOf("javascript:void(0)", "intent://x#Intent;end", "file:///etc/hosts", "", "  ")) {
      assertNull(link, LinkMenu.build(link, null, normal))
    }
    // A script link around a picture still leaves the picture.
    assertEquals(
      Action.OPEN_BACKGROUND,
      actions("javascript:void(0)", "https://example.com/cat.png", normal).first(),
    )
  }

  @Test
  fun movingToThePrivateListenerChangesOnlyVirtualHosts() {
    assertEquals(
      "http://abc.web.localhost:5001/a|b?q={x}#y",
      LinkMenu.onPort("http://abc.web.localhost:5000/a|b?q={x}#y", 5001),
    )
    assertEquals("https://example.com:5000/", LinkMenu.onPort("https://example.com:5000/", 5001))
    assertEquals("https://example.com/", LinkMenu.onPort("https://example.com/", 5001))
  }
}
