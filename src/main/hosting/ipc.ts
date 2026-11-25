import { dialog, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { endpointPort, isLoopbackEndpoint, type HostingDraft } from '@shared/hosting'
import { normalizeEndpointSeed } from '@shared/reachability'
import type { ConfigStore } from '../config'
import { isChromeSender, shellForSender } from '../ipc/shared'
import type { BrowserShell } from '../shell'
import type { TorManager } from '../tor/manager'
import { verifyTcpThroughSocks, type OnionManager } from '../tor/onion'
import { certificateInfo, generateSelfSignedCertificate, saveCertificateFiles } from './certificates'
import { discoverReachability } from './discover'
import { HttpsSetup, probeProtocol } from './https-setup'
import type { NetworkWatch } from './network-watch'
import type { PortMappingService } from './port-mapping'
import type { PublicAddressService } from './public-address'
import type { HostingService } from './service'
import type { TlsProxyManager } from './tls-proxy'

export interface HostingIpcDeps {
  shell: BrowserShell
  config: ConfigStore
  hosting: HostingService
  onion: OnionManager
  tlsProxy: TlsProxyManager
  portMappings: PortMappingService
  publicAddress: PublicAddressService
  network: NetworkWatch
  tor: TorManager
}

/**
 * Hosted services, their private shares, endpoint discovery, router mappings and
 * certificates. Everything here signs through the active identity, so it is
 * chrome-only.
 */
export function registerHostingIpc(deps: HostingIpcDeps): void {
  const shellFor = (event: Electron.IpcMainInvokeEvent): BrowserShell =>
    shellForSender(event, deps.shell)
  const chromeOnly = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isChromeSender(event)) throw new Error('Services are only available to the browser chrome')
  }

  const https = new HttpsSetup(deps.tlsProxy)
  /** Correct the HTTPS setup before anything is published for this service. */
  const prepareHttps = async (id: string): Promise<void> => {
    const service = deps.hosting.find(id)
    if (service) await https.prepare(service)
  }

  ipcMain.handle('ncc:hosting-state', () => deps.hosting.state())
  ipcMain.handle('ncc:hosting-create', (event, draft: unknown) => {
    chromeOnly(event)
    deps.hosting.create(draft as HostingDraft)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-update', (event, payload: unknown) => {
    chromeOnly(event)
    const { id, draft } = (payload ?? {}) as { id?: unknown; draft?: unknown }
    if (typeof id !== 'string') throw new Error('A service id is required')
    deps.hosting.update(id, draft as HostingDraft)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-remove', async (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A service id is required')
    await deps.onion.remove(id)
    await deps.tlsProxy.remove(id)
    deps.hosting.remove(id)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-publish', async (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A service id is required')
    const service = deps.hosting.find(id)
    if (service?.endpoints.some((endpoint) => endpoint.url.includes('.onion'))) {
      // An onion endpoint is only real while Tor runs; re-attach before publishing it.
      await deps.onion.restoreAll().catch(() => undefined)
    }
    await prepareHttps(id)
    return deps.hosting.publish(id)
  })
  ipcMain.handle('ncc:hosting-share', async (event, payload: unknown) => {
    chromeOnly(event)
    const { id, recipient, days, label } = (payload ?? {}) as {
      id?: unknown
      recipient?: unknown
      days?: unknown
      label?: unknown
    }
    if (typeof id !== 'string' || typeof recipient !== 'string') {
      throw new Error('A service id and a recipient npub are required')
    }
    await prepareHttps(id)
    return deps.hosting.share(
      id,
      recipient,
      typeof days === 'number' ? days : 7,
      typeof label === 'string' ? label : undefined
    )
  })
  ipcMain.handle('ncc:hosting-share-many', async (event, payload: unknown) => {
    chromeOnly(event)
    const { id, recipients, days, label } = (payload ?? {}) as {
      id?: unknown
      recipients?: unknown
      days?: unknown
      label?: unknown
    }
    if (typeof id !== 'string' || !Array.isArray(recipients)) {
      throw new Error('A service id and at least one recipient are required')
    }
    const list = recipients.filter((recipient): recipient is string => typeof recipient === 'string')
    await prepareHttps(id)
    return deps.hosting.shareMany(
      id,
      list,
      typeof days === 'number' ? days : 7,
      typeof label === 'string' ? label : undefined
    )
  })

  ipcMain.handle('ncc:hosting-revoke-share', (event, shareId: unknown) => {
    chromeOnly(event)
    if (typeof shareId !== 'string') throw new Error('A share id is required')
    return deps.hosting.revokeShare(shareId)
  })
  ipcMain.handle('ncc:hosting-forget-share', (event, shareId: unknown) => {
    chromeOnly(event)
    if (typeof shareId !== 'string') throw new Error('A share id is required')
    deps.hosting.forgetShare(shareId)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-forget-received', (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A share id is required')
    deps.hosting.forgetReceived(id)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-discover-endpoints', async (event, seedUrl: unknown, options: unknown) => {
    chromeOnly(event)
    if (typeof seedUrl !== 'string') throw new Error('An endpoint seed must be a string')
    const optionBag = (options ?? {}) as {
      external?: unknown
      port?: unknown
      secure?: unknown
    }
    let seed = ''
    if (seedUrl.trim()) {
      const normalized = normalizeEndpointSeed(seedUrl)
      if (!normalized) throw new Error('Enter an endpoint as IP:port or http(s)://…')
      seed = normalized
    }
    const port =
      typeof optionBag.port === 'number' && Number.isInteger(optionBag.port) && optionBag.port > 0 && optionBag.port <= 65535
        ? optionBag.port
        : undefined
    if (optionBag.port !== undefined && port === undefined) {
      throw new Error('Enter a port between 1 and 65535')
    }
    const config = deps.config.get()
    const mode = config.externalAddressChecks ?? 'ask'
    const explicit = Boolean(optionBag.external)
    if (explicit && mode === 'never') {
      throw new Error('Public address checks are off in Settings → General')
    }
    const torPreferred = config.preferTor === true
    const runExternal = !torPreferred && (explicit || mode === 'always')
    const report = await discoverReachability({
      seedUrl: seed,
      external: runExternal,
      ...(port === undefined ? {} : { port }),
      ...(optionBag.secure === true ? { secure: true } : {}),
      ...(runExternal
        ? { lookupPublicAddress: () => deps.publicAddress.lookup(explicit) }
        : {})
    })
    report.torReady = deps.tor.status().ready
    if (explicit && torPreferred) {
      report.externalCheck = 'declined'
      report.warnings.push('Public address checks are skipped while Tor is preferred.')
    }
    return report
  })
  ipcMain.handle('ncc:hosting-map-port', async (event, input: unknown) => {
    chromeOnly(event)
    const payload = (input ?? {}) as { localPort?: unknown; secure?: unknown }
    if (typeof payload.localPort !== 'number') throw new Error('A local port is required')
    return deps.portMappings.map({
      localPort: payload.localPort,
      secure: payload.secure === true
    })
  })
  ipcMain.handle('ncc:hosting-unmap-port', async (event, localPort: unknown) => {
    chromeOnly(event)
    if (typeof localPort !== 'number') throw new Error('A local port is required')
    await deps.portMappings.remove(localPort)
  })
  ipcMain.handle('ncc:hosting-import-certificate', async (event) => {
    chromeOnly(event)
    const browserShell = shellFor(event)
    const result = await dialog.showOpenDialog(browserShell.window, {
      title: 'Choose the server certificate',
      properties: ['openFile'],
      filters: [
        { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const info = certificateInfo(readFileSync(path))
    if (!info) throw new Error('That file is not a readable PEM or DER certificate')
    return info
  })
  ipcMain.handle('ncc:hosting-generate-certificate', async (event, input: unknown) => {
    chromeOnly(event)
    const payload = (input ?? {}) as {
      commonName?: unknown
      altNames?: unknown
      days?: unknown
    }
    const commonName = typeof payload.commonName === 'string' ? payload.commonName.trim() : ''
    if (!commonName || commonName.length > 255) throw new Error('A common name is required')
    const altNames = Array.isArray(payload.altNames)
      ? payload.altNames
          .filter((name): name is string => typeof name === 'string')
          .map((name) => name.trim())
          .filter(Boolean)
          .slice(0, 32)
      : []
    const days = typeof payload.days === 'number' ? payload.days : 365
    let folder = process.env.NCC_CERTIFICATE_FOLDER?.trim() || ''
    if (!folder) {
      const result = await dialog.showOpenDialog(shellFor(event).window, {
        title: 'Choose where to save the certificate and key',
        properties: ['openDirectory', 'createDirectory']
      })
      folder = result.filePaths[0] ?? ''
      if (result.canceled || !folder) return null
    }
    const generated = await generateSelfSignedCertificate({ commonName, altNames, days })
    const paths = saveCertificateFiles(
      folder,
      `ncc-${commonName.replace(/[^a-zA-Z0-9.-]+/g, '-')}`,
      generated.cert,
      generated.key
    )
    return { ...generated.info, ...paths }
  })
  ipcMain.handle('ncc:hosting-verify-port', async (event, localPort: unknown) => {
    chromeOnly(event)
    if (typeof localPort !== 'number') throw new Error('A local port is required')
    const mapping = deps.portMappings.find(localPort)
    if (!mapping) throw new Error('No port mapping exists for that local port')
    let proxy: string
    try {
      proxy = (await deps.tor.ensureReady()).proxy
    } catch (error) {
      throw new Error(
        `Tor is needed for the reachability check: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const verified = await verifyTcpThroughSocks(
      mapping.externalAddress,
      mapping.externalPort,
      proxy
    )
    return deps.portMappings.reportCheck(
      localPort,
      verified,
      Math.floor(Date.now() / 1000)
    )
  })
  ipcMain.handle('ncc:hosting-network-changes', (event) => {
    chromeOnly(event)
    return deps.network.list()
  })
  ipcMain.handle('ncc:hosting-replace-address', async (event, payload: unknown) => {
    chromeOnly(event)
    const {
      from,
      to,
      publish
    } = (payload ?? {}) as { from?: unknown; to?: unknown; publish?: unknown }
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('The old and new address are required')
    }
    if (!/^[0-9a-f:.]+$/i.test(from) || !/^[0-9a-f:.]+$/i.test(to)) {
      throw new Error('Only IP address changes can be applied automatically')
    }
    const result = deps.hosting.replaceAddress(from, to)
    const failures: Array<{ id: string; title?: string; error: string }> = []
    if (publish === true) {
      for (const id of result.ids) {
        const service = deps.hosting.find(id)
        try {
          await deps.hosting.publish(id)
        } catch (error) {
          failures.push({
            id,
            ...(service?.title ? { title: service.title } : {}),
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    return { ...result, failures, state: deps.hosting.state() }
  })
  ipcMain.handle('ncc:hosting-port-mappings', (event) => {
    chromeOnly(event)
    return deps.portMappings.list()
  })
  ipcMain.handle('ncc:hosting-publish-onion', async (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A service id is required')
    const service = deps.hosting.find(id)
    if (!service) throw new Error('That service no longer exists')
    const local = service.endpoints.find((endpoint) => isLoopbackEndpoint(endpoint))
    if (!local) {
      throw new Error(
        'Tor forwarding needs a loopback endpoint such as http://127.0.0.1:8080. Add one to this service first.'
      )
    }
    // Tor encrypts the onion route itself, so a plain HTTP server stays plain even if
    // its address was saved as https://.
    const target = new URL(local.url)
    const protocol = await probeProtocol(
      target.hostname.replace(/^\[|\]$/g, ''),
      endpointPort(target)
    )
    if (protocol === 'http' && target.protocol === 'https:') {
      target.port = String(endpointPort(target))
      target.protocol = 'http:'
    }
    const onion = await deps.onion.publish(id, { url: target.toString() })
    deps.hosting.attachOnion(id, onion.url)
    return { state: deps.hosting.state(), onion }
  })
  ipcMain.handle('ncc:hosting-remove-onion', async (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A service id is required')
    await deps.onion.remove(id)
    deps.hosting.detachOnion(id)
    return deps.hosting.state()
  })
  ipcMain.handle('ncc:hosting-publish-tls-proxy', async (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A service id is required')
    const service = deps.hosting.find(id)
    if (!service) throw new Error('That service no longer exists')
    await https.enable(service)
    deps.hosting.dropGeneratedEndpoints(id)
    deps.hosting.refresh()
    const proxy = deps.tlsProxy.status(id)!
    return { state: deps.hosting.state(), proxy }
  })
  ipcMain.handle('ncc:hosting-remove-tls-proxy', async (event, id: unknown) => {
    chromeOnly(event)
    if (typeof id !== 'string') throw new Error('A service id is required')
    await deps.tlsProxy.remove(id)
    deps.hosting.dropGeneratedEndpoints(id)
    deps.hosting.refresh()
    return deps.hosting.state()
  })
}
