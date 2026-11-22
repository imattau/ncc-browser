import type { ReactNode } from 'react'
import type { CommandId } from '@shared/commands'
import type { SyncDevice } from '@shared/sync-status'
import type {
  Bookmark,
  DownloadNotice,
  IdentityProfile,
  IdentityStatus,
  NavState,
  OverlayReason,
  TabHistory
} from '@shared/types'
import type { PasswordContext } from '@shared/passwords'
import { ChromeMenu } from '../ChromeMenu'
import { DownloadsPanel } from '../DownloadsPanel'
import { HistoryPanel } from '../HistoryPanel'
import { IdentityChooser } from '../IdentityChooser'
import { PasswordsPanel } from '../PasswordsPanel'
import type { PopoverAnchor } from '../Popover'
import { ShareNostrPanel } from '../ShareNostrPanel'
import { SiteInfoPanel } from '../SiteInfoPanel'
import { TabOverflowMenu } from '../TabOverflowMenu'

interface OverlayPanelsProps {
  overlay: OverlayReason | null
  state: NavState
  identity: IdentityStatus | null
  bookmarks: Bookmark[]
  syncDevices: SyncDevice[]
  downloads: DownloadNotice[]
  history: TabHistory | null
  passwordContext: PasswordContext | null
  passwordAnchor: PopoverAnchor | null
  passwordBusy: boolean
  passwordError: string | null
  siteInfoAnchor: PopoverAnchor | null
  identityChooserProfiles: IdentityProfile[]
  identityChooserAnchor: PopoverAnchor | null
  identityChooserBusy: boolean
  identityChooserError: string | null
  onClose: () => void
  onOpenWallet: () => void
  onOpenSettings: () => void
  onCommand: (command: CommandId) => void
  onPublishService: (url: string) => void
  onOpenBookmark: (url: string) => void
  onRemoveBookmark: (url: string) => void
  onOpenDeviceTab: (url: string) => void
  onCancelDownload: (id: string) => void
  onRevealDownload: (id: string) => void
  onClearDownloads: () => void
  onSelectIdentity: (id: string) => void
  onSelectHistory: (index: number) => void
  onClearHistory: () => void
  onUnlockPasswords: () => void
  onLockPasswords: () => void
  onFillPassword: (id: string) => void
  onCopyPassword: (id: string, field: 'username' | 'password' | 'totp') => void
  onAddPassword: () => void
  onManagePasswords: () => void
  onReload: () => void
  onSelectTab: (id: string) => void
  onCloseTab: (id?: string) => void
  onNewTab: () => void
}

/**
 * The stacked overlay panels. `settings` and `wallet` replace the page area instead
 * (see App), so they are not in this map. Keying the map by `OverlayReason` keeps
 * adding an overlay to a single place.
 */
export function OverlayPanels({
  overlay,
  state,
  identity,
  bookmarks,
  syncDevices,
  downloads,
  history,
  passwordContext,
  passwordAnchor,
  passwordBusy,
  passwordError,
  siteInfoAnchor,
  identityChooserProfiles,
  identityChooserAnchor,
  identityChooserBusy,
  identityChooserError,
  onClose,
  onOpenWallet,
  onOpenSettings,
  onCommand,
  onPublishService,
  onOpenBookmark,
  onRemoveBookmark,
  onOpenDeviceTab,
  onCancelDownload,
  onRevealDownload,
  onClearDownloads,
  onSelectIdentity,
  onSelectHistory,
  onClearHistory,
  onUnlockPasswords,
  onLockPasswords,
  onFillPassword,
  onCopyPassword,
  onAddPassword,
  onManagePasswords,
  onReload,
  onSelectTab,
  onCloseTab,
  onNewTab
}: OverlayPanelsProps) {
  const panels: Partial<Record<OverlayReason, ReactNode>> = {
    menu: (
      <ChromeMenu
        state={state}
        identity={identity}
        bookmarks={bookmarks}
        onCommand={onCommand}
        onOpenWallet={onOpenWallet}
        onPublishService={onPublishService}
        onOpenBookmark={onOpenBookmark}
        onRemoveBookmark={onRemoveBookmark}
        devices={syncDevices}
        onOpenDeviceTab={onOpenDeviceTab}
        onClose={onClose}
      />
    ),
    downloads: (
      <DownloadsPanel
        downloads={downloads}
        onClose={onClose}
        onCancel={onCancelDownload}
        onReveal={onRevealDownload}
        onClear={onClearDownloads}
      />
    ),
    'identity-chooser': (
      <IdentityChooser
        identities={identityChooserProfiles}
        anchor={identityChooserAnchor}
        busy={identityChooserBusy}
        error={identityChooserError}
        onClose={onClose}
        onSelect={onSelectIdentity}
      />
    ),
    'share-nostr': (
      <ShareNostrPanel
        title={state.title}
        url={state.displayUrl}
        npub={identity?.npub ?? ''}
        onClose={onClose}
        onPost={(comment) => window.ncc.shareNostr(comment)}
      />
    ),
    history: (
      <HistoryPanel
        history={history}
        onClose={onClose}
        onSelect={onSelectHistory}
        onClear={onClearHistory}
      />
    ),
    passwords: (
      <PasswordsPanel
        context={passwordContext}
        anchor={passwordAnchor}
        busy={passwordBusy}
        error={passwordError}
        onClose={onClose}
        onUnlock={onUnlockPasswords}
        onLock={onLockPasswords}
        onFill={onFillPassword}
        onCopy={onCopyPassword}
        onAdd={onAddPassword}
        onManage={onManagePasswords}
      />
    ),
    'site-info': (
      <SiteInfoPanel
        state={state}
        anchorRect={siteInfoAnchor}
        onClose={onClose}
        onOpenSettings={onOpenSettings}
        onReload={onReload}
      />
    ),
    tabs: (
      <TabOverflowMenu
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        onClose={onClose}
      />
    )
  }

  return <>{overlay ? panels[overlay] ?? null : null}</>
}
