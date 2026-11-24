import { contextBridge, ipcRenderer } from 'electron'
import type { NccApi } from '@shared/api'
import type { SyncStatus } from '@shared/sync-status'
import type { AutomationState } from '@shared/automation'
import type { ExtensionsState } from '@shared/extensions'
import { readAppearanceBootArgument } from '@shared/appearance'
import {
  DEFAULT_APPEARANCE,
  type AppConfig,
  type Bookmark,
  type DownloadNotice,
  type NavState,
  type SignerRequest
} from '@shared/types'
import type {
  PasswordContext,
  PasskeyConfirmationRequest,
  PasswordSaveRequest,
  PasswordToast,
  PasswordVaultStatus
} from '@shared/passwords'
import type { PaymentCardDraft, PaymentCardSaveRequest } from '@shared/payment-cards'
import type { HostingState } from '@shared/hosting'
import type { NetworkChange, PortStatusEvent } from '@shared/reachability'
import type { ContactsState } from '@shared/contacts'
import type { IdentityProfileMetadata } from '@shared/types/identity'
import type { NsiteProgress, NsitePublishState } from '@shared/nsite-publish'

const api: NccApi = {
  initialAppearance: readAppearanceBootArgument(process.argv) ?? DEFAULT_APPEARANCE,
  navigate: (input) => ipcRenderer.invoke('ncc:navigate', input),
  back: () => ipcRenderer.invoke('ncc:back'),
  forward: () => ipcRenderer.invoke('ncc:forward'),
  reload: () => ipcRenderer.invoke('ncc:reload'),
  forceReload: () => ipcRenderer.invoke('ncc:force-reload'),
  stop: () => ipcRenderer.invoke('ncc:stop'),
  toggleTor: () => ipcRenderer.invoke('ncc:toggle-tor'),
  insecureChoice: (choice) => ipcRenderer.invoke('ncc:insecure-choice', choice),
  newTab: (input) => ipcRenderer.invoke('ncc:new-tab', input),
  newPrivateTab: (input) => ipcRenderer.invoke('ncc:new-private-tab', input),
  newTorTab: (input) => ipcRenderer.invoke('ncc:new-tor-tab', input),
  closeTab: (id) => ipcRenderer.invoke('ncc:close-tab', id),
  selectTab: (id) => ipcRenderer.invoke('ncc:select-tab', id),
  moveTab: (id, toIndex) => ipcRenderer.invoke('ncc:move-tab', { id, toIndex }),
  detachTab: (id, screenX, screenY) => ipcRenderer.invoke('ncc:detach-tab', { id, screenX, screenY }),
  duplicateTab: (id) => ipcRenderer.invoke('ncc:duplicate-tab', id),
  reloadTab: (id) => ipcRenderer.invoke('ncc:reload-tab', id),
  toggleMute: (id) => ipcRenderer.invoke('ncc:toggle-mute', id),
  closeOtherTabs: (id) => ipcRenderer.invoke('ncc:close-other-tabs', id),
  closeTabsToRight: (id) => ipcRenderer.invoke('ncc:close-tabs-right', id),
  showTabMenu: (id) => ipcRenderer.invoke('ncc:tab-menu', id),
  showNewTabMenu: () => ipcRenderer.invoke('ncc:new-tab-menu'),
  tabHistory: (id) => ipcRenderer.invoke('ncc:tab-history', id),
  goToHistoryIndex: (index) => ipcRenderer.invoke('ncc:go-history-index', index),
  clearHistory: () => ipcRenderer.invoke('ncc:clear-history'),
  showHistoryMenu: (direction) => ipcRenderer.invoke('ncc:history-menu', direction),
  getState: () => ipcRenderer.invoke('ncc:get-state'),
  getConfig: () => ipcRenderer.invoke('ncc:get-config'),
  bookmarks: () => ipcRenderer.invoke('ncc:bookmarks'),
  createHomeShortcut: (site) => ipcRenderer.invoke('ncc:create-home-shortcut', site),
  toggleBookmark: () => ipcRenderer.invoke('ncc:toggle-bookmark'),
  removeBookmark: (url) => ipcRenderer.invoke('ncc:remove-bookmark', url),
  downloads: () => ipcRenderer.invoke('ncc:get-downloads'),
  cancelDownload: (id) => ipcRenderer.invoke('ncc:cancel-download', id),
  revealDownload: (id) => ipcRenderer.invoke('ncc:reveal-download', id),
  clearDownloads: () => ipcRenderer.invoke('ncc:clear-downloads'),
  minimizeWindow: () => ipcRenderer.invoke('ncc:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('ncc:window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('ncc:window-close'),
  setRelays: (relays) => ipcRenderer.invoke('ncc:set-relays', relays),
  resolveRelayLocator: (input) => ipcRenderer.invoke('ncc:resolve-relay-locator', input),
  setGossip: (value) => ipcRenderer.invoke('ncc:set-gossip', value),
  setAnchorRequired: (value) => ipcRenderer.invoke('ncc:set-anchor-required', value),
  setExternalAddressChecks: (value) => ipcRenderer.invoke('ncc:set-external-address-checks', value),
  setPreferTor: (value) => ipcRenderer.invoke('ncc:set-prefer-tor', value),
  setEphemeralSigner: (value) => ipcRenderer.invoke('ncc:set-ephemeral-signer', value),
  setTorMode: (mode) => ipcRenderer.invoke('ncc:set-tor-mode', mode),
  setTorSocks: (socks) => ipcRenderer.invoke('ncc:set-tor-socks', socks),
  setTorConfig: (config) => ipcRenderer.invoke('ncc:set-tor-config', config),
  setSecurityConfig: (config) => ipcRenderer.invoke('ncc:set-security-config', config),
  setProtectionException: (origin, allowed, kind) => ipcRenderer.invoke('ncc:set-protection-exception', origin, allowed, kind),
  protectionSummary: (url, kind) => ipcRenderer.invoke('ncc:protection-summary', url, kind),
  removeHttpException: (key) => ipcRenderer.invoke('ncc:remove-http-exception', key),
  clearHttpExceptions: () => ipcRenderer.invoke('ncc:clear-http-exceptions'),
  omniboxSuggest: (input) => ipcRenderer.invoke('ncc:omnibox-suggest', input),
  clearBrowsingHistory: () => ipcRenderer.invoke('ncc:clear-browsing-history'),
  siteData: () => ipcRenderer.invoke('ncc:site-data'),
  clearSiteData: (options) => ipcRenderer.invoke('ncc:clear-site-data', options),
  cacheInfo: () => ipcRenderer.invoke('ncc:cache-info'),
  clearCache: () => ipcRenderer.invoke('ncc:clear-cache'),
  reResolveSite: () => ipcRenderer.invoke('ncc:re-resolve-site'),
  openInWhiteNoise: (npub) => ipcRenderer.invoke('ncc:open-in-white-noise', npub),
  setSearchConfig: (config) => ipcRenderer.invoke('ncc:set-search-config', config),
  setAppearance: (appearance) => ipcRenderer.invoke('ncc:set-appearance', appearance),
  hostingState: () => ipcRenderer.invoke('ncc:hosting-state'),
  hostingCreate: (draft) => ipcRenderer.invoke('ncc:hosting-create', draft),
  hostingUpdate: (id, draft) => ipcRenderer.invoke('ncc:hosting-update', id, draft),
  hostingRemove: (id) => ipcRenderer.invoke('ncc:hosting-remove', id),
  hostingPublish: (id) => ipcRenderer.invoke('ncc:hosting-publish', id),
  hostingShare: (id, recipient, days, label) =>
    ipcRenderer.invoke('ncc:hosting-share', { id, recipient, days, label }),
  hostingShareMany: (id, recipients, days, label) =>
    ipcRenderer.invoke('ncc:hosting-share-many', { id, recipients, days, label }),
  hostingRevokeShare: (shareId) => ipcRenderer.invoke('ncc:hosting-revoke-share', shareId),
  hostingForgetReceived: (id) => ipcRenderer.invoke('ncc:hosting-forget-received', id),
  hostingDiscoverEndpoints: (seedUrl, options) =>
    ipcRenderer.invoke('ncc:hosting-discover-endpoints', seedUrl, options),
  hostingMapPort: (input) => ipcRenderer.invoke('ncc:hosting-map-port', input),
  hostingUnmapPort: (localPort) => ipcRenderer.invoke('ncc:hosting-unmap-port', localPort),
  hostingVerifyPort: (localPort) => ipcRenderer.invoke('ncc:hosting-verify-port', localPort),
  hostingNetworkChanges: () => ipcRenderer.invoke('ncc:hosting-network-changes'),
  hostingReplaceAddress: (from, to, publish) =>
    ipcRenderer.invoke('ncc:hosting-replace-address', { from, to, publish }),
  onPortStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PortStatusEvent): void =>
      listener(status)
    ipcRenderer.on('ncc:port-status', handler)
    return () => {
      ipcRenderer.removeListener('ncc:port-status', handler)
    }
  },
  onNetworkChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, change: NetworkChange): void =>
      listener(change)
    ipcRenderer.on('ncc:network-changed', handler)
    return () => {
      ipcRenderer.removeListener('ncc:network-changed', handler)
    }
  },
  hostingPortMappings: () => ipcRenderer.invoke('ncc:hosting-port-mappings'),
  hostingPublishOnion: (serviceId) => ipcRenderer.invoke('ncc:hosting-publish-onion', serviceId),
  hostingRemoveOnion: (serviceId) => ipcRenderer.invoke('ncc:hosting-remove-onion', serviceId),
  hostingImportCertificate: () => ipcRenderer.invoke('ncc:hosting-import-certificate'),
  hostingGenerateCertificate: (input) =>
    ipcRenderer.invoke('ncc:hosting-generate-certificate', input),
  hostingPublishTlsProxy: (serviceId) => ipcRenderer.invoke('ncc:hosting-publish-tls-proxy', serviceId),
  hostingRemoveTlsProxy: (serviceId) => ipcRenderer.invoke('ncc:hosting-remove-tls-proxy', serviceId),
  onHostingChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: HostingState): void => listener(state)
    ipcRenderer.on('ncc:hosting-changed', handler)
    return () => {
      ipcRenderer.removeListener('ncc:hosting-changed', handler)
    }
  },
  nsiteState: () => ipcRenderer.invoke('ncc:nsite-state'),
  nsiteDiscover: () => ipcRenderer.invoke('ncc:nsite-discover'),
  nsitePickFolder: () => ipcRenderer.invoke('ncc:nsite-pick-folder'),
  nsitePublish: (input) => ipcRenderer.invoke('ncc:nsite-publish', input),
  nsiteVerify: (id) => ipcRenderer.invoke('ncc:nsite-verify', id),
  nsiteCancel: () => ipcRenderer.invoke('ncc:nsite-cancel'),
  nsiteRemove: (id) => ipcRenderer.invoke('ncc:nsite-remove', id),
  onNsiteProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: NsiteProgress): void =>
      listener(progress)
    ipcRenderer.on('ncc:nsite-progress', handler)
    return () => {
      ipcRenderer.removeListener('ncc:nsite-progress', handler)
    }
  },
  onNsiteChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NsitePublishState): void =>
      listener(state)
    ipcRenderer.on('ncc:nsite-changed', handler)
    return () => {
      ipcRenderer.removeListener('ncc:nsite-changed', handler)
    }
  },
  contactsState: () => ipcRenderer.invoke('ncc:contacts-state'),
  contactsRefresh: () => ipcRenderer.invoke('ncc:contacts-refresh'),
  onContactsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ContactsState): void => listener(state)
    ipcRenderer.on('ncc:contacts-changed', handler)
    return () => {
      ipcRenderer.removeListener('ncc:contacts-changed', handler)
    }
  },
  syncStatus: () => ipcRenderer.invoke('ncc:sync-status'),
  syncNow: () => ipcRenderer.invoke('ncc:sync-now'),
  syncConfigure: (patch) => ipcRenderer.invoke('ncc:sync-configure', patch),
  syncRemoveDevice: (id) => ipcRenderer.invoke('ncc:sync-remove-device', id),
  syncOpenTab: (url) => ipcRenderer.invoke('ncc:sync-open-tab', url),
  onSyncStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: SyncStatus): void =>
      listener(status)
    ipcRenderer.on('ncc:sync-status', handler)
    return () => {
      ipcRenderer.removeListener('ncc:sync-status', handler)
    }
  },
  passwordsStatus: () => ipcRenderer.invoke('ncc:password-status'),
  passwordsContext: () => ipcRenderer.invoke('ncc:password-context'),
  passwordsUnlock: () => ipcRenderer.invoke('ncc:password-unlock'),
  passwordsLock: () => ipcRenderer.invoke('ncc:password-lock'),
  passwordsList: () => ipcRenderer.invoke('ncc:password-list'),
  passwordsHealth: () => ipcRenderer.invoke('ncc:password-health'),
  passwordsEntry: (id) => ipcRenderer.invoke('ncc:password-entry', id),
  passwordsReveal: (id) => ipcRenderer.invoke('ncc:password-reveal', id),
  passwordsTotp: (id) => ipcRenderer.invoke('ncc:password-totp', id),
  passwordsCopy: (id, field) => ipcRenderer.invoke('ncc:password-copy', id, field),
  passwordsGenerate: (options) => ipcRenderer.invoke('ncc:password-generate', options),
  passwordsSave: (entry) => ipcRenderer.invoke('ncc:password-save', entry),
  passwordsRemove: (id) => ipcRenderer.invoke('ncc:password-remove', id),
  passwordsFavorite: (id, favorite) => ipcRenderer.invoke('ncc:password-favorite', id, favorite),
  passwordsSync: () => ipcRenderer.invoke('ncc:password-sync'),
  passwordsFill: (id) => ipcRenderer.invoke('ncc:password-fill', id),
  passwordsSetConfig: (config) => ipcRenderer.invoke('ncc:password-config', config),
  passwordsRemoveNever: (origin) => ipcRenderer.invoke('ncc:password-remove-never', origin),
  passwordsRespond: (id, action) => ipcRenderer.invoke('ncc:password-respond', id, action),
  passwordsImportOpen: () => ipcRenderer.invoke('ncc:password-import-open'),
  passwordsImportCommit: (id, mode) => ipcRenderer.invoke('ncc:password-import-commit', id, mode),
  passwordsExport: (format) => ipcRenderer.invoke('ncc:password-export', format),
  paymentCardsStatus: () => ipcRenderer.invoke('ncc:payment-cards-status'),
  paymentCardsList: () => ipcRenderer.invoke('ncc:payment-cards-list'),
  paymentCardsSave: (card) => ipcRenderer.invoke('ncc:payment-cards-save', card),
  paymentCardsRemove: (id) => ipcRenderer.invoke('ncc:payment-cards-remove', id),
  paymentCardsSync: () => ipcRenderer.invoke('ncc:payment-cards-sync'),
  paymentCardsRespond: (id, action) => ipcRenderer.invoke('ncc:payment-cards-respond', id, action),
  onPaymentCardsStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Awaited<ReturnType<NccApi['paymentCardsStatus']>>): void => listener(status)
    ipcRenderer.on('ncc:payment-card-status', handler)
    return () => ipcRenderer.removeListener('ncc:payment-card-status', handler)
  },
  walletStatus: () => ipcRenderer.invoke('ncc:wallet-status'),
  walletSnapshot: () => ipcRenderer.invoke('ncc:wallet-snapshot'),
  walletSettings: () => ipcRenderer.invoke('ncc:wallet-settings'),
  walletSetSettings: (config) => ipcRenderer.invoke('ncc:wallet-set-settings', config),
  walletPrepareBitcoinSend: (address, amount) => ipcRenderer.invoke('ncc:wallet-btc-prepare', address, amount),
  walletConfirmBitcoinSend: (token) => ipcRenderer.invoke('ncc:wallet-btc-confirm', token),
  walletLoadMoneroRecord: () => ipcRenderer.invoke('ncc:wallet-xmr-load'),
  walletSaveMoneroRecord: (record) => ipcRenderer.invoke('ncc:wallet-xmr-save', record),
  walletDeleteMoneroRecord: () => ipcRenderer.invoke('ncc:wallet-xmr-delete'),
  nwcStatus: () => ipcRenderer.invoke('ncc:nwc-status'),
  nwcConnect: (uri) => ipcRenderer.invoke('ncc:nwc-connect', uri),
  nwcDisconnect: () => ipcRenderer.invoke('ncc:nwc-disconnect'),
  nwcRefresh: () => ipcRenderer.invoke('ncc:nwc-refresh'),
  nwcPay: (invoice) => ipcRenderer.invoke('ncc:nwc-pay', invoice),
  nwcMakeInvoice: (params) => ipcRenderer.invoke('ncc:nwc-make-invoice', params),
  nwcLookupInvoice: (params) => ipcRenderer.invoke('ncc:nwc-lookup-invoice', params),
  automationState: () => ipcRenderer.invoke('ncc:automation-state'),
  automationSetEnabled: (value) => ipcRenderer.invoke('ncc:automation-set-enabled', value),
  automationAddAgent: (name) => ipcRenderer.invoke('ncc:automation-add-agent', name),
  automationRemoveAgent: (id) => ipcRenderer.invoke('ncc:automation-remove-agent', id),
  automationRegenerateIdentity: (id) => ipcRenderer.invoke('ncc:automation-regenerate-identity', id),
  automationRevoke: (agentId, site) => ipcRenderer.invoke('ncc:automation-revoke', agentId, site),
  automationRevokeSign: (agentId, site) =>
    ipcRenderer.invoke('ncc:automation-revoke-sign', agentId, site),
  automationRevealCommand: (agentId) => ipcRenderer.invoke('ncc:automation-reveal-command', agentId),
  automationRefreshProfile: (agentId) => ipcRenderer.invoke('ncc:automation-refresh-profile', agentId),
  automationCopyCommand: (command) => ipcRenderer.invoke('ncc:automation-copy-command', command),
  onAutomation: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AutomationState): void =>
      listener(state)
    ipcRenderer.on('ncc:automation-state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:automation-state', handler)
    }
  },
  extensionsState: () => ipcRenderer.invoke('ncc:extensions-state'),
  extensionsSetDeveloper: (value) => ipcRenderer.invoke('ncc:extensions-set-developer', value),
  extensionsInstall: (kind) => ipcRenderer.invoke('ncc:extensions-install', kind),
  extensionsRemove: (id) => ipcRenderer.invoke('ncc:extensions-remove', id),
  extensionsSetEnabled: (id, value) => ipcRenderer.invoke('ncc:extensions-set-enabled', id, value),
  extensionsSetPrivate: (id, value) => ipcRenderer.invoke('ncc:extensions-set-private', id, value),
  extensionsReload: (id) => ipcRenderer.invoke('ncc:extensions-reload', id),
  extensionsOpenOptions: (id) => ipcRenderer.invoke('ncc:extensions-open-options', id),
  extensionsReveal: (id) => ipcRenderer.invoke('ncc:extensions-reveal', id),
  extensionsAction: (id, anchor) => ipcRenderer.invoke('ncc:extensions-action', id, anchor),
  torStatus: () => ipcRenderer.invoke('ncc:tor-status'),
  appInfo: () => ipcRenderer.invoke('ncc:app-info'),
  nccsearchCheckUpdate: () => ipcRenderer.invoke('ncc:nccsearch-check-update'),
  nccsearchInstallUpdate: (version) => ipcRenderer.invoke('ncc:nccsearch-install-update', version),
  torTest: () => ipcRenderer.invoke('ncc:tor-test'),
  torRestart: () => ipcRenderer.invoke('ncc:tor-restart'),
  identity: () => ipcRenderer.invoke('ncc:identity-status'),
  identityList: () => ipcRenderer.invoke('ncc:identity-list'),
  identityProfileMetadata: (pubkeys) => ipcRenderer.invoke('ncc:identity-profile-metadata', pubkeys),
  onIdentityProfileMetadata: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, profiles: IdentityProfileMetadata[]): void => listener(profiles)
    ipcRenderer.on('ncc:identity-profile-metadata-changed', handler)
    return () => ipcRenderer.removeListener('ncc:identity-profile-metadata-changed', handler)
  },
  identitySelect: (id) => ipcRenderer.invoke('ncc:identity-select', id),
  identitySetDefault: (id) => ipcRenderer.invoke('ncc:identity-default', id),
  identityRemove: (id) => ipcRenderer.invoke('ncc:identity-remove-profile', id),
  shareNostr: (comment) => ipcRenderer.invoke('ncc:share-nostr', comment),
  importIdentity: (secret) => ipcRenderer.invoke('ncc:identity-import', secret),
  generateIdentity: () => ipcRenderer.invoke('ncc:identity-generate'),
  generateEphemeralIdentity: () => ipcRenderer.invoke('ncc:identity-generate-ephemeral'),
  ephemeralIdentitySecret: () => ipcRenderer.invoke('ncc:identity-ephemeral-secret'),
  saveEphemeralIdentity: () => ipcRenderer.invoke('ncc:identity-save-ephemeral'),
  clearEphemeralIdentity: () => ipcRenderer.invoke('ncc:identity-clear-ephemeral'),
  removeIdentity: () => ipcRenderer.invoke('ncc:identity-remove'),
  identityConnectBunker: (url) => ipcRenderer.invoke('ncc:identity-connect-bunker', url),
  identityDisconnect: () => ipcRenderer.invoke('ncc:identity-disconnect'),
  signerPermissions: () => ipcRenderer.invoke('ncc:signer-permissions'),
  revokePermission: (origin) => ipcRenderer.invoke('ncc:revoke-permission', origin),
  pendingSignerRequests: () => ipcRenderer.invoke('ncc:signer-pending'),
  signerOrigin: (url) => ipcRenderer.invoke('ncc:signer-origin', url),
  setSignerTrust: (url, trusted) => ipcRenderer.invoke('ncc:signer-trust', { url, trusted }),
  respondToSigner: (id, allow, remember) =>
    ipcRenderer.invoke('ncc:signer-response', { id, allow, remember }),
  runCommand: (command) => ipcRenderer.invoke('ncc:command', command),
  setOverlay: (reason, active) => ipcRenderer.invoke('ncc:set-overlay', { reason, active }),
  onOpenSettings: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { section: string }): void =>
      listener(payload)
    ipcRenderer.on('ncc:open-settings', handler)
    return () => {
      ipcRenderer.removeListener('ncc:open-settings', handler)
    }
  },
  onCloseMenu: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:close-menu', handler)
    return () => {
      ipcRenderer.removeListener('ncc:close-menu', handler)
    }
  },
  onOpenHistory: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:open-history', handler)
    return () => {
      ipcRenderer.removeListener('ncc:open-history', handler)
    }
  },
  onOpenDownloads: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:open-downloads', handler)
    return () => {
      ipcRenderer.removeListener('ncc:open-downloads', handler)
    }
  },
  onBookmarks: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, bookmarks: Bookmark[]): void =>
      listener(bookmarks)
    ipcRenderer.on('ncc:bookmarks', handler)
    return () => {
      ipcRenderer.removeListener('ncc:bookmarks', handler)
    }
  },
  onSignerRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: SignerRequest): void =>
      listener(request)
    ipcRenderer.on('ncc:signer-request', handler)
    return () => {
      ipcRenderer.removeListener('ncc:signer-request', handler)
    }
  },
  onSignerResolved: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { id: string }): void =>
      listener(payload.id)
    ipcRenderer.on('ncc:signer-resolved', handler)
    return () => {
      ipcRenderer.removeListener('ncc:signer-resolved', handler)
    }
  },
  onFocusAddress: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('ncc:focus-address', handler)
    return () => {
      ipcRenderer.removeListener('ncc:focus-address', handler)
    }
  },
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NavState): void => listener(state)
    ipcRenderer.on('ncc:state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:state', handler)
    }
  },
  onConfig: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, config: AppConfig): void =>
      listener(config)
    ipcRenderer.on('ncc:config', handler)
    return () => {
      ipcRenderer.removeListener('ncc:config', handler)
    }
  },
  onPasswordStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PasswordVaultStatus): void =>
      listener(status)
    ipcRenderer.on('ncc:password-status', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-status', handler)
    }
  },
  onPasswordContext: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, context: PasswordContext): void =>
      listener(context)
    ipcRenderer.on('ncc:password-context', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-context', handler)
    }
  },
  onPasswordSaveRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: PasswordSaveRequest): void =>
      listener(request)
    ipcRenderer.on('ncc:password-save-request', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-save-request', handler)
    }
  },
  onPasskeyConfirmation: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: PasskeyConfirmationRequest): void => listener(request)
    ipcRenderer.on('ncc:passkey-confirmation', handler)
    return () => ipcRenderer.removeListener('ncc:passkey-confirmation', handler)
  },
  onPasskeyConfirmationResolved: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string): void => listener(id)
    ipcRenderer.on('ncc:passkey-confirmation-resolved', handler)
    return () => ipcRenderer.removeListener('ncc:passkey-confirmation-resolved', handler)
  },
  respondToPasskeyConfirmation: (id, choice) =>
    ipcRenderer.invoke('ncc:passkey-confirmation-response', { id, choice }),
  onPaymentCardSaveRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: PaymentCardSaveRequest): void => listener(request)
    ipcRenderer.on('ncc:payment-card-save-request', handler)
    return () => ipcRenderer.removeListener('ncc:payment-card-save-request', handler)
  },
  onPasswordToast: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, toast: PasswordToast): void =>
      listener(toast)
    ipcRenderer.on('ncc:password-toast', handler)
    return () => {
      ipcRenderer.removeListener('ncc:password-toast', handler)
    }
  },
  onExtensions: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ExtensionsState): void =>
      listener(state)
    ipcRenderer.on('ncc:extensions-state', handler)
    return () => {
      ipcRenderer.removeListener('ncc:extensions-state', handler)
    }
  },
  onDownload: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, notice: DownloadNotice): void =>
      listener(notice)
    ipcRenderer.on('ncc:download', handler)
    return () => {
      ipcRenderer.removeListener('ncc:download', handler)
    }
  }
}

contextBridge.exposeInMainWorld('ncc', api)
