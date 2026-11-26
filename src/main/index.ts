import { app } from 'electron'
import { join } from 'node:path'
import { createBrowserStack } from './bootstrap/browser'
import { createFoundation } from './bootstrap/foundation'
import {
  installSecondInstance,
  installShutdown,
  installUrlOpener,
  installWindowLifecycle
} from './bootstrap/lifecycle'
import { createRuntime } from './bootstrap/runtime'
import { createServices } from './bootstrap/services'
import { createShellStack } from './bootstrap/shell'
import { registerPrivilegedSchemes } from './schemes'
import { installDefaultUserAgent } from './user-agents'

// Custom schemes must be registered before the app is ready, in a single call.
registerPrivilegedSchemes()

// Electron's Chromium build exposes the FedCM JS surface
// (navigator.credentials.get({ identity })) but never wires up the embedder-side
// delegate that actually serves it, so any site attempting it (e.g. Google Identity
// Services) gets a bare NetworkError instead of a working or absent API. Disabling the
// feature makes those sites fall back to their classic popup/redirect sign-in flow,
// which does work here.
app.commandLine.appendSwitch('disable-features', 'FedCm,FedCmIdPRegistration')

app.setName('Nostr Navigator')
installDefaultUserAgent()
// Keep the profile created by earlier NCC Browser builds across the rename.
app.setPath('userData', join(app.getPath('appData'), 'NCC Browser'))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const runtime = createRuntime()

// Lifecycle handlers subscribe before `whenReady` so a macOS URL delivered during
// startup is not lost, and so shutdown order matches the service registration order.
installUrlOpener(runtime)
installWindowLifecycle(runtime)
installShutdown(runtime)

app.whenReady().then(async () => {
  // Register as an available handler so the operating system can offer Nostr
  // Navigator in its default-browser chooser. The user still selects the default.
  for (const scheme of ['http', 'https']) app.setAsDefaultProtocolClient(scheme)

  const foundation = await createFoundation(runtime)
  const browser = await createBrowserStack(runtime, foundation)
  const shellStack = createShellStack(runtime, foundation, browser)

  createServices(runtime, foundation, browser, shellStack)
  installSecondInstance(runtime)
})
