import { useEffect, useMemo, useState } from 'react'
import { contactLabel, type ContactList, type ContactProfile } from '@shared/contacts'
import {
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  MIN_SHARE_DAYS,
  parseRecipient,
  type HostedService,
  type ServiceShare
} from '@shared/hosting'
import { messageOf } from '../../lib/format'
import type { HostingFeedback, ShareFailure, ShareResult } from './types'

type Feedback = Pick<HostingFeedback, 'apply' | 'setBusy' | 'setError'>

export interface HostingSharesApi {
  contacts: ContactList | null
  contactsLoading: boolean
  contactsError: string | null
  refreshContacts: () => Promise<void>
  /** The service whose share panel is open, if any. */
  sharing: string | null
  toggleShare: (serviceId: string) => void
  openShare: (serviceId: string) => void
  shareRecipients: string[]
  toggleRecipient: (pubkey: string) => void
  shareQuery: string
  setShareQuery: (value: string) => void
  manualRecipient: string
  setManualRecipient: (value: string) => void
  addManualRecipient: () => void
  shareDays: string
  setShareDays: (value: string) => void
  shareLabel: string
  setShareLabel: (value: string) => void
  shareResults: ShareResult[]
  shareFailures: ShareFailure[]
  resetShares: () => void
  filteredContacts: ContactProfile[]
  createShare: (service: HostedService) => Promise<void>
  revoke: (share: ServiceShare) => Promise<void>
  renewShare: (service: HostedService, share: ServiceShare) => Promise<void>
}

/** Contact list, recipient selection and share creation for one service at a time. */
export function useHostingShares(feedback: Feedback): HostingSharesApi {
  const { apply, setBusy, setError } = feedback
  const [contacts, setContacts] = useState<ContactList | null>(null)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [shareRecipients, setShareRecipients] = useState<string[]>([])
  const [shareQuery, setShareQuery] = useState('')
  const [manualRecipient, setManualRecipient] = useState('')
  const [shareDays, setShareDays] = useState(String(DEFAULT_SHARE_DAYS))
  const [shareLabel, setShareLabel] = useState('')
  const [shareResults, setShareResults] = useState<ShareResult[]>([])
  const [shareFailures, setShareFailures] = useState<ShareFailure[]>([])

  useEffect(() => {
    let alive = true
    void window.ncc
      .contactsState()
      .then((state) => {
        if (!alive) return
        setContacts(state.list)
        setContactsLoading(state.refreshing)
        setContactsError(state.error ?? null)
      })
      .catch(() => undefined)
    const off = window.ncc.onContactsChanged((state) => {
      if (!alive) return
      setContacts(state.list)
      setContactsLoading(state.refreshing)
      setContactsError(state.error ?? null)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const toggleShare = (serviceId: string): void => {
    setSharing((current) => (current === serviceId ? null : serviceId))
    setShareResults([])
    setShareFailures([])
  }

  const openShare = (serviceId: string): void => {
    setSharing(serviceId)
    setShareRecipients([])
    setShareResults([])
    setShareFailures([])
  }

  const resetShares = (): void => {
    setShareResults([])
    setShareFailures([])
  }

  const refreshContacts = async (): Promise<void> => {
    setContactsLoading(true)
    try {
      const state = await window.ncc.contactsRefresh()
      setContacts(state.list)
      setContactsError(state.error ?? null)
    } catch (error) {
      setContactsError(messageOf(error))
    } finally {
      setContactsLoading(false)
    }
  }

  const toggleRecipient = (pubkey: string): void => {
    setShareRecipients((current) =>
      current.includes(pubkey) ? current.filter((value) => value !== pubkey) : [...current, pubkey]
    )
  }

  const addManualRecipient = (): void => {
    const recipient = parseRecipient(manualRecipient)
    if (!recipient) {
      setError('Enter a valid npub or 64-character public key')
      return
    }
    setShareRecipients((current) => (current.includes(recipient) ? current : [...current, recipient]))
    setManualRecipient('')
  }

  const filteredContacts = useMemo(() => {
    const query = shareQuery.trim().toLowerCase()
    const list = [...(contacts?.contacts ?? [])].sort((a, b) =>
      contactLabel(a).localeCompare(contactLabel(b))
    )
    if (!query) return list
    return list.filter((contact) =>
      [contact.displayName, contact.name, contact.nip05, contact.pubkey].some((value) =>
        value?.toLowerCase().includes(query)
      )
    )
  }, [contacts, shareQuery])

  const createShare = async (service: HostedService): Promise<void> => {
    if (shareRecipients.length === 0) {
      setError('Choose at least one recipient')
      return
    }
    setBusy(true)
    setError(null)
    setShareResults([])
    setShareFailures([])
    try {
      const result = await window.ncc.hostingShareMany(
        service.id,
        shareRecipients,
        Math.min(MAX_SHARE_DAYS, Math.max(MIN_SHARE_DAYS, Number(shareDays) || DEFAULT_SHARE_DAYS)),
        shareLabel
      )
      setShareResults(result.shares.map((entry) => ({ recipient: entry.recipient, address: entry.address })))
      setShareFailures(result.failures)
      if (result.shares.length > 0) {
        setShareRecipients([])
        setShareLabel('')
      }
      apply(await window.ncc.hostingState())
    } catch (shareError) {
      setError(messageOf(shareError))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (share: ServiceShare): Promise<void> => {
    if (!window.confirm('Revoke this share? The recipient may still have the endpoint until it rotates.')) return
    setBusy(true)
    try {
      await window.ncc.hostingRevokeShare(share.id)
      apply(await window.ncc.hostingState())
    } catch (revokeError) {
      setError(messageOf(revokeError))
    } finally {
      setBusy(false)
    }
  }

  const renewShare = async (service: HostedService, share: ServiceShare): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingShare(
        service.id,
        share.recipient,
        DEFAULT_SHARE_DAYS,
        share.label
      )
      setShareResults([{ recipient: share.recipient, address: result.address }])
      setShareFailures([])
      apply(await window.ncc.hostingState())
    } catch (renewError) {
      setError(messageOf(renewError))
    } finally {
      setBusy(false)
    }
  }

  return {
    contacts,
    contactsLoading,
    contactsError,
    refreshContacts,
    sharing,
    toggleShare,
    openShare,
    shareRecipients,
    toggleRecipient,
    shareQuery,
    setShareQuery,
    manualRecipient,
    setManualRecipient,
    addManualRecipient,
    shareDays,
    setShareDays,
    shareLabel,
    setShareLabel,
    shareResults,
    shareFailures,
    resetShares,
    filteredContacts,
    createShare,
    revoke,
    renewShare
  }
}
