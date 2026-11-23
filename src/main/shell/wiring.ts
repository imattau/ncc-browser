import { shell } from 'electron'
import { installContentContextMenu } from '../context-menu'
import { fetchFavicon } from '../favicon'
import { isAllowedTorUrl } from '../tor/guard'
import {
  isAuthPopupUrl,
  isDialogSizedPopupFeatures,
  isHttpExemptUrl,
  shouldUpgradeHttp,
  webHttpKey
} from '../security'
import { formatDisplayUrl, isOnionPageUrl, safeProtocol, tabTitle } from './format'
import type { ShellInternals } from './internals'
import { loadWebTarget, navigateInTab } from './navigation'
import { CONTENT_WEB_PREFERENCES, type Tab } from './types'

/** Attach the content-view listeners for one tab. */
export function wireTab(internals: ShellInternals, tab: Tab): void {
  const contents = tab.view.webContents

  contents.on('did-start-loading', () => {
    tab.loading = true
    internals.syncState()
  })

  contents.on('did-stop-loading', () => {
    tab.loading = false
    const url = contents.isDestroyed() ? '' : contents.getURL()
    const script = url ? internals.deps.protectionScriptForUrl?.(url, tab.kind) ?? '' : ''
    if (script) void contents.executeJavaScript(script, true).catch(() => undefined)
    internals.scheduleSessionSave()
    internals.syncState()
  })

  contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    tab.failure = null
    tab.security = null
    const onion = tab.kind === 'tor' || isOnionPageUrl(url)
    tab.tor = { onionAvailable: false, active: onion }
    if (tab.kind !== 'tor') internals.deps.torGuard.set(contents.id, onion)
    tab.displayUrl = formatDisplayUrl(url)
    internals.applyUrlToTab(tab, url)
    internals.syncState()
  })

  contents.on('did-navigate', (_event, url) => {
    tab.displayUrl = formatDisplayUrl(url)
    internals.applyUrlToTab(tab, url)
    // Only normal tabs contribute to address-bar suggestions.
    if (tab.kind === 'normal' && /^(ncc:\/\/|nsite:\/\/|https?:\/\/)/i.test(url)) {
      internals.deps.omnibox.recordVisit(tab.displayUrl, tabTitle(tab), 'normal')
    }
    internals.scheduleSessionSave()
    internals.syncState()
  })

  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return
    tab.displayUrl = formatDisplayUrl(url)
    internals.scheduleSessionSave()
    internals.syncState()
  })

  contents.on('page-title-updated', () => {
    if (tab.kind === 'normal' && tab.displayUrl) {
      const title = contents.isDestroyed() ? '' : contents.getTitle()
      if (title) internals.deps.omnibox.updateTitle(tab.displayUrl, title, 'normal')
    }
    internals.syncState()
  })

  contents.on('page-favicon-updated', (_event, favicons) => {
    const candidate = favicons.find((favicon) => /^(https?|ncc|data:image\/)/i.test(favicon))
    if (!candidate) return
    if (candidate.startsWith('data:image/')) {
      if (candidate.length <= 350_000) {
        tab.favicon = candidate
        internals.syncState()
      }
      return
    }
    // Main-process fetches are not attributed to a webContents, so apply the
    // Tor-page allowlist here as well; a clearnet favicon would leak the IP.
    if (tab.tor.active && !isAllowedTorUrl(candidate)) return
    const referer = contents.getURL()
    void fetchFavicon(contents.session, candidate, referer).then((dataUrl) => {
      if (!dataUrl || tab.favicon === dataUrl || !internals.hasTab(tab)) return
      tab.favicon = dataUrl
      internals.syncState()
    })
  })

  tab.audible = contents.isCurrentlyAudible()
  tab.muted = contents.isAudioMuted()
  contents.on('audio-state-changed', (event) => {
    tab.audible = event.audible
    tab.muted = contents.isAudioMuted()
    internals.syncState()
  })

  contents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      if (/ERR_ABORTED/.test(errorDescription)) return

      if (tab.pendingHttp) {
        const pending = tab.pendingHttp
        tab.pendingHttp = null
        const policy = internals.deps.httpPolicies[tab.kind]
        if (policy.isAllowed(pending.key) || (policy.mode() !== 'only' && !policy.warn())) {
          void loadWebTarget(internals, tab, pending.original)
        } else {
          internals.showInsecurePrompt(tab, pending.original, pending.key)
        }
        return
      }

      tab.failure ??= {
        code: validatedURL.startsWith('ncc://') ? 'endpoint-unreachable' : 'load-failed',
        message: errorDescription
      }
      internals.syncState()
    }
  )

  contents.on('render-process-gone', (_event, details) => {
    tab.failure = { code: 'renderer-gone', message: details.reason }
    internals.syncState()
  })

  // A WebContentsView has no owning BrowserWindow to react to `window.close()` for it
  // (e.g. a Google SSO popup that closes itself once auth completes); left alone, the
  // page's own close request destroys the webContents out from under the tab, and
  // `tab.view.webContents` later reads as undefined and crashes tabTitle(). Removing
  // the tab as soon as its contents are destroyed keeps the tab list in sync.
  contents.on('destroyed', () => {
    if (internals.hasTab(tab)) internals.closeTab(tab.id)
  })

  contents.setWindowOpenHandler(({ url, features }) => {
    // Most popups (ads, spam) are denied and reopened as an ordinary tab. A popup to a
    // known identity-provider host, or one sized like a deliberate sign-in/payment
    // dialog (most OAuth buttons open a same-origin relay URL first, which then
    // redirects to the provider, so the host is rarely visible at open time), is let
    // through as a real auxiliary window instead, because the site's own JS needs
    // `window.opener` to `postMessage` the result back — losing that relationship is
    // what made "Sign in with Google" popups fail silently when reopened as a plain
    // tab.
    if (isAuthPopupUrl(url) || isDialogSizedPopupFeatures(features)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            ...CONTENT_WEB_PREFERENCES,
            session: contents.session,
            preload: internals.deps.contentPreloadPath
          }
        }
      }
    }
    void internals.openInNewTab(url, tab.kind)
    return { action: 'deny' }
  })

  // The auxiliary popup window above has no native parent (some Wayland compositors
  // don't support the xdg_foreign protocol Electron/GTK needs to set one without
  // warning, and setting `parent` there is not reliably honored either), so closing it
  // can leave the main window never getting input focus back — the whole app then
  // looks frozen even though it is still running. Reclaim focus explicitly instead of
  // depending on native window-transiency to do it.
  contents.on('did-create-window', (childWindow) => {
    childWindow.once('closed', () => {
      if (!tab.owner.window.isDestroyed()) tab.owner.window.focus()
    })
  })

  contents.on('will-navigate', (event, url) => {
    if (tab.programmatic) return
    const protocol = safeProtocol(url)
    if (!protocol) return
    if (protocol === 'http:' || protocol === 'https:') {
      const policy = internals.deps.httpPolicies[tab.kind]
      const key = webHttpKey(url)
      if (
        protocol === 'http:' &&
        key &&
        !isHttpExemptUrl(url) &&
        !policy.isAllowed(key) &&
        (shouldUpgradeHttp(url, policy.mode()) || policy.warn())
      ) {
        event.preventDefault()
        void navigateInTab(internals, tab, url)
        return
      }
    }
    if (
      protocol === 'ncc:' ||
      protocol === 'nsite:' ||
      protocol === 'http:' ||
      protocol === 'https:'
    ) {
      // Same-origin links navigate natively; the origin already names the service or
      // site, so re-entering the resolver would only repeat the load.
      return
    }
    event.preventDefault()
    void shell.openExternal(url)
  })

  contents.on('will-attach-webview', (event) => event.preventDefault())

  installContentContextMenu(contents, {
    getWindow: () => tab.owner.window,
    openInNewTab: (url) => {
      void internals.openInNewTab(url, tab.kind)
    },
    extensionItems: (url) => internals.deps.extensionContextItems?.(url) ?? []
  })

  // Keyboard shortcuts are routed in main so they work while the page has focus.
  contents.on('before-input-event', (event, input) => internals.handleInput(event, input))
}
