import { app } from 'electron'
import type { CommandId } from '@shared/commands'
import type { BrowserShell } from '../shell'

/**
 * Where the NCC-05 specification lives. Opened as a tab in the current tab's transport
 * mode: the browser can render it, and a Tor tab must not leak the request to the
 * desktop browser.
 */
const NCC_SPEC_URL =
  'https://github.com/imattau/nostr-community-conventions/blob/master/ncc-05/README.md'

/** Keyboard/shortcut commands. They only use the shell's public surface. */
export function runShellCommand(shell: BrowserShell, command: CommandId): void {
  switch (command) {
    case 'new-tab':
      shell.newTab()
      shell.focusAddress()
      break
    case 'new-private-tab':
      shell.newPrivateTab()
      shell.focusAddress()
      break
    case 'new-tor-tab':
      shell.newTorTab()
      shell.focusAddress()
      break
    case 'close-tab':
      shell.closeTab()
      break
    case 'next-tab':
      shell.nextTab()
      break
    case 'previous-tab':
      shell.previousTab()
      break
    case 'focus-address':
      shell.focusAddress()
      break
    case 'back':
      shell.back()
      break
    case 'forward':
      shell.forward()
      break
    case 'reload':
      shell.reload()
      break
    case 'force-reload':
      void shell.forceReload()
      break
    case 'stop':
      shell.stop()
      break
    case 'zoom-in':
      shell.zoomIn()
      break
    case 'zoom-out':
      shell.zoomOut()
      break
    case 'zoom-reset':
      shell.zoomReset()
      break
    case 'toggle-bookmarks-view':
      shell.toggleBookmarksVisibility()
      break
    case 'toggle-tab-layout':
      shell.toggleTabLayout()
      break
    case 'toggle-page-devtools':
      shell.togglePageDevTools()
      break
    case 'toggle-browser-devtools':
      shell.toggleChromeDevTools()
      break
    case 'toggle-bookmark':
      shell.toggleBookmark()
      break
    case 'open-history':
      shell.sendToChrome('ncc:open-history')
      break
    case 'open-downloads':
      shell.sendToChrome('ncc:open-downloads')
      break
    case 'open-settings':
      shell.sendToChrome('ncc:open-settings', { section: 'general' })
      break
    case 'open-services':
      shell.sendToChrome('ncc:open-settings', { section: 'services' })
      break
    case 'open-site-publisher':
      shell.sendToChrome('ncc:open-settings', { section: 'sites' })
      break
    case 'open-identity':
      shell.sendToChrome('ncc:open-settings', { section: 'identity' })
      break
    case 'open-passwords':
      shell.sendToChrome('ncc:open-settings', { section: 'passwords' })
      break
    case 'open-spec': {
      // Open documentation in a tab, not the desktop browser: history, zoom and the
      // current transport mode all apply, and a Tor tab does not leak to clearnet.
      const kind = shell.getState().tabKind
      if (kind === 'tor') shell.newTorTab(NCC_SPEC_URL)
      else if (kind === 'private') shell.newPrivateTab(NCC_SPEC_URL)
      else shell.newTab(NCC_SPEC_URL)
      break
    }
    case 'quit':
      app.quit()
      break
  }
}
