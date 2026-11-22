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

// Custom schemes must be registered before the app is ready, in a single call.
registerPrivilegedSchemes()

app.setName('Nostr Navigator')
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
