import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrefillDraft } from '../components/hosting/serviceDraft'
import type { IdentityProfile, IdentityStatus, OverlayReason } from '@shared/types'
import type { PopoverAnchor } from '../components/Popover'
import type { SettingsSection } from '../components/SettingsPage'

interface Options {
  refreshHistory: () => Promise<unknown>
  setIdentity: (status: IdentityStatus) => void
}

export interface OverlayController {
  overlay: OverlayReason | null
  overlayRef: React.RefObject<OverlayReason | null>
  showOverlay: (next: OverlayReason | null) => void
  closeOverlay: () => void
  settingsSection: SettingsSection
  openSettings: (section?: SettingsSection) => void
  hostingDraft: PrefillDraft | null
  setHostingDraft: (draft: PrefillDraft | null) => void
  siteInfoAnchor: PopoverAnchor | null
  setSiteInfoAnchor: (anchor: PopoverAnchor | null) => void
  identityChooserProfiles: IdentityProfile[]
  identityChooserAnchor: PopoverAnchor | null
  identityChooserBusy: boolean
  identityChooserError: string | null
  openIdentityChooser: (anchor: PopoverAnchor) => Promise<void>
  selectIdentity: (id: string) => Promise<void>
}

/**
 * One overlay at a time. The shell hides every content view while an overlay is open,
 * so popovers can cover the page area instead of being clipped to the chrome.
 */
export function useOverlayController({
  refreshHistory,
  setIdentity
}: Options): OverlayController {
  const [overlay, setOverlay] = useState<OverlayReason | null>(null)
  const overlayRef = useRef<OverlayReason | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [hostingDraft, setHostingDraft] = useState<PrefillDraft | null>(null)
  const [siteInfoAnchor, setSiteInfoAnchor] = useState<PopoverAnchor | null>(null)
  const [identityChooserProfiles, setIdentityChooserProfiles] = useState<IdentityProfile[]>([])
  const [identityChooserAnchor, setIdentityChooserAnchor] = useState<PopoverAnchor | null>(null)
  const [identityChooserBusy, setIdentityChooserBusy] = useState(false)
  const [identityChooserError, setIdentityChooserError] = useState<string | null>(null)

  const showOverlay = useCallback((next: OverlayReason | null) => {
    const current = overlayRef.current
    if (current === next) return
    if (current) void window.ncc.setOverlay(current, false)
    overlayRef.current = next
    setOverlay(next)
    if (next) void window.ncc.setOverlay(next, true)
  }, [])

  const closeOverlay = useCallback(() => showOverlay(null), [showOverlay])

  const openSettings = useCallback(
    (section: SettingsSection = 'general') => {
      setSettingsSection(section)
      showOverlay('settings')
    },
    [showOverlay]
  )

  const openIdentityChooser = useCallback(
    async (anchor: PopoverAnchor): Promise<void> => {
      try {
        const list = await window.ncc.identityList()
        if (list.identities.length > 1) {
          setIdentityChooserProfiles(list.identities)
          setIdentityChooserAnchor(anchor)
          setIdentityChooserError(null)
          showOverlay('identity-chooser')
        } else {
          openSettings('identity')
        }
      } catch {
        openSettings('identity')
      }
    },
    [openSettings, showOverlay]
  )

  const selectIdentity = useCallback(
    async (id: string): Promise<void> => {
      setIdentityChooserBusy(true)
      setIdentityChooserError(null)
      try {
        setIdentity(await window.ncc.identitySelect(id))
        closeOverlay()
      } catch (error) {
        setIdentityChooserError(error instanceof Error ? error.message : String(error))
      } finally {
        setIdentityChooserBusy(false)
      }
    },
    [closeOverlay, setIdentity]
  )

  useEffect(() => {
    const offOpen = window.ncc.onOpenSettings((payload) =>
      openSettings(
        payload.section === 'identity' ||
          payload.section === 'appearance' ||
          payload.section === 'passwords' ||
          payload.section === 'services' ||
          payload.section === 'sites' ||
          payload.section === 'security' ||
          payload.section === 'trusted' ||
          payload.section === 'about'
          ? payload.section
          : 'general'
      )
    )
    const offClose = window.ncc.onCloseMenu(() => {
      // Window blur closes menus and popovers, but not a page the user is editing.
      if (overlayRef.current && overlayRef.current !== 'settings') showOverlay(null)
    })
    return () => {
      offOpen()
      offClose()
    }
  }, [openSettings, showOverlay])

  useEffect(() => {
    const offHistory = window.ncc.onOpenHistory(() => {
      void refreshHistory()
      showOverlay('history')
    })
    const offDownloads = window.ncc.onOpenDownloads(() => showOverlay('downloads'))
    return () => {
      offHistory()
      offDownloads()
    }
  }, [refreshHistory, showOverlay])

  return {
    overlay,
    overlayRef,
    showOverlay,
    closeOverlay,
    settingsSection,
    openSettings,
    hostingDraft,
    setHostingDraft,
    siteInfoAnchor,
    setSiteInfoAnchor,
    identityChooserProfiles,
    identityChooserAnchor,
    identityChooserBusy,
    identityChooserError,
    openIdentityChooser,
    selectIdentity
  }
}
