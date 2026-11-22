import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { OverlayReason } from '@shared/types'
import type {
  PasswordContext,
  PasswordSaveRequest,
  PasswordToast,
  PasswordVaultStatus
} from '@shared/passwords'
import type { PaymentCardSaveRequest } from '@shared/payment-cards'
import type { PopoverAnchor } from '../components/Popover'
import type { SettingsSection } from '../components/SettingsPage'
import { messageOf } from '../lib/format'

interface Options {
  showOverlay: (next: OverlayReason | null) => void
  closeOverlay: () => void
  overlayRef: RefObject<OverlayReason | null>
  url: string
  activeTabId: string | null
  openSettings: (section?: SettingsSection) => void
}

export interface PasswordPrompts {
  passwordStatus: PasswordVaultStatus | null
  passwordContext: PasswordContext | null
  passwordAnchor: PopoverAnchor | null
  passwordBusy: boolean
  passwordError: string | null
  passwordSave: PasswordSaveRequest | null
  passwordSaveBusy: boolean
  passwordSaveError: string | null
  paymentCardSave: PaymentCardSaveRequest | null
  paymentCardSaveBusy: boolean
  paymentCardSaveError: string | null
  passwordDraftOrigin: string | null
  passwordToast: PasswordToast | null
  clearPasswordDraftOrigin: () => void
  openPasswords: (anchor: PopoverAnchor) => void
  unlockPasswords: () => Promise<void>
  lockPasswords: () => Promise<void>
  fillPassword: (id: string) => Promise<void>
  copyPassword: (id: string, field: 'username' | 'password' | 'totp') => Promise<void>
  openPasswordSettings: (origin?: string | null) => void
  respondToPasswordSave: (action: 'save' | 'never' | 'dismiss') => Promise<void>
  respondToPaymentCardSave: (action: 'save' | 'dismiss') => Promise<void>
}

/** The password vault UI state, its prompts and the card-save prompt. */
export function usePasswordPrompts({
  showOverlay,
  closeOverlay,
  overlayRef,
  url,
  activeTabId,
  openSettings
}: Options): PasswordPrompts {
  const [passwordStatus, setPasswordStatus] = useState<PasswordVaultStatus | null>(null)
  const [passwordContext, setPasswordContext] = useState<PasswordContext | null>(null)
  const [passwordAnchor, setPasswordAnchor] = useState<PopoverAnchor | null>(null)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSave, setPasswordSave] = useState<PasswordSaveRequest | null>(null)
  const [passwordSaveBusy, setPasswordSaveBusy] = useState(false)
  const [passwordSaveError, setPasswordSaveError] = useState<string | null>(null)
  const [paymentCardSave, setPaymentCardSave] = useState<PaymentCardSaveRequest | null>(null)
  const [paymentCardSaveBusy, setPaymentCardSaveBusy] = useState(false)
  const [paymentCardSaveError, setPaymentCardSaveError] = useState<string | null>(null)
  const [passwordDraftOrigin, setPasswordDraftOrigin] = useState<string | null>(null)
  const [passwordToast, setPasswordToast] = useState<PasswordToast | null>(null)

  const refreshPasswords = useCallback(async (): Promise<void> => {
    const [status, context] = await Promise.all([
      window.ncc.passwordsStatus(),
      window.ncc.passwordsContext()
    ])
    setPasswordStatus(status)
    setPasswordContext(context)
  }, [])

  useEffect(() => {
    let alive = true
    void window.ncc.passwordsStatus().then((next) => {
      if (alive) setPasswordStatus(next)
    })
    void window.ncc.passwordsContext().then((next) => {
      if (alive) setPasswordContext(next)
    })
    const offStatus = window.ncc.onPasswordStatus(setPasswordStatus)
    const offContext = window.ncc.onPasswordContext(setPasswordContext)
    const offSave = window.ncc.onPasswordSaveRequest((request) => {
      setPasswordToast(null)
      setPasswordSave(request)
      setPasswordSaveError(null)
      setPasswordDraftOrigin(null)
      showOverlay('password-save')
    })
    const offCardSave = window.ncc.onPaymentCardSaveRequest((request) => {
      setPaymentCardSave(request)
      setPaymentCardSaveError(null)
      showOverlay('payment-card-save')
    })
    const offToast = window.ncc.onPasswordToast((toast) => setPasswordToast(toast))
    return () => {
      alive = false
      offStatus()
      offContext()
      offSave()
      offCardSave()
      offToast()
    }
  }, [showOverlay])

  useEffect(() => {
    let alive = true
    void window.ncc.passwordsContext().then((next) => {
      if (alive) setPasswordContext(next)
    })
    return () => {
      alive = false
    }
  }, [url, activeTabId])

  useEffect(() => {
    if (overlayRef.current === 'passwords') showOverlay(null)
  }, [url, activeTabId, overlayRef, showOverlay])

  useEffect(() => {
    let alive = true
    void window.ncc.passwordsContext().then((next) => {
      if (alive) setPasswordContext(next)
    })
    return () => {
      alive = false
    }
  }, [passwordStatus?.unlocked, passwordStatus?.lastSyncedAt])

  useEffect(() => {
    if (!passwordToast) return
    const timer = window.setTimeout(() => setPasswordToast(null), 4_500)
    return () => window.clearTimeout(timer)
  }, [passwordToast])

  const openPasswords = useCallback(
    (anchor: PopoverAnchor) => {
      setPasswordAnchor(anchor)
      setPasswordError(null)
      void refreshPasswords()
      showOverlay('passwords')
    },
    [refreshPasswords, showOverlay]
  )

  const unlockPasswords = useCallback(async (): Promise<void> => {
    setPasswordBusy(true)
    setPasswordError(null)
    try {
      const status = await window.ncc.passwordsUnlock()
      setPasswordStatus(status)
      await refreshPasswords()
      if (status.error) setPasswordError(status.error)
    } catch (unlockError) {
      setPasswordError(messageOf(unlockError))
    } finally {
      setPasswordBusy(false)
    }
  }, [refreshPasswords])

  const lockPasswords = useCallback(async (): Promise<void> => {
    setPasswordStatus(await window.ncc.passwordsLock())
    await refreshPasswords()
  }, [refreshPasswords])

  const fillPassword = useCallback(
    async (id: string): Promise<void> => {
      closeOverlay()
      const result = await window.ncc.passwordsFill(id)
      if (!result.ok) setPasswordToast({ tone: 'error', message: result.error ?? 'Could not fill' })
      else setPasswordToast({ tone: 'ok', message: 'Login filled.' })
      await refreshPasswords()
    },
    [closeOverlay, refreshPasswords]
  )

  const copyPassword = useCallback(
    async (id: string, field: 'username' | 'password' | 'totp'): Promise<void> => {
      const result = await window.ncc.passwordsCopy(id, field)
      if (!result.ok) {
        setPasswordToast({ tone: 'error', message: result.error ?? 'Could not copy' })
        return
      }
      setPasswordToast({
        tone: 'ok',
        message: result.clearsAt
          ? 'Copied. The clipboard clears in 30 seconds.'
          : 'Username copied.'
      })
    },
    []
  )

  const openPasswordSettings = useCallback(
    (origin?: string | null) => {
      setPasswordAnchor(null)
      setPasswordDraftOrigin(origin ?? null)
      openSettings('passwords')
    },
    [openSettings]
  )

  const respondToPasswordSave = useCallback(
    async (action: 'save' | 'never' | 'dismiss'): Promise<void> => {
      const request = passwordSave
      if (!request) return
      setPasswordSaveBusy(true)
      setPasswordSaveError(null)
      try {
        const result = await window.ncc.passwordsRespond(request.id, action)
        if (!result.ok) {
          setPasswordSaveError(result.error ?? 'Could not save the login')
          return
        }
        setPasswordSave(null)
        closeOverlay()
        await refreshPasswords()
      } finally {
        setPasswordSaveBusy(false)
      }
    },
    [closeOverlay, passwordSave, refreshPasswords]
  )

  const respondToPaymentCardSave = useCallback(
    async (action: 'save' | 'dismiss'): Promise<void> => {
      if (!paymentCardSave) return
      setPaymentCardSaveBusy(true)
      setPaymentCardSaveError(null)
      try {
        const result = await window.ncc.paymentCardsRespond(paymentCardSave.id, action)
        if (!result.ok) {
          setPaymentCardSaveError(result.error ?? 'Could not save card')
          return
        }
        setPaymentCardSave(null)
        showOverlay(null)
        if (result.pending) {
          setPasswordToast({
            tone: 'warn',
            message: 'Card saved locally; relay sync will retry.'
          })
        }
      } catch (error) {
        setPaymentCardSaveError(messageOf(error))
      } finally {
        setPaymentCardSaveBusy(false)
      }
    },
    [paymentCardSave, showOverlay]
  )

  return {
    passwordStatus,
    passwordContext,
    passwordAnchor,
    passwordBusy,
    passwordError,
    passwordSave,
    passwordSaveBusy,
    passwordSaveError,
    paymentCardSave,
    paymentCardSaveBusy,
    paymentCardSaveError,
    passwordDraftOrigin,
    passwordToast,
    clearPasswordDraftOrigin: () => setPasswordDraftOrigin(null),
    openPasswords,
    unlockPasswords,
    lockPasswords,
    fillPassword,
    copyPassword,
    openPasswordSettings,
    respondToPasswordSave,
    respondToPaymentCardSave
  }
}
