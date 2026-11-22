import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { OverlayReason, SignerRequest } from '@shared/types'
import type { PasskeyConfirmationRequest } from '@shared/passwords'

interface Options {
  showOverlay: (next: OverlayReason | null) => void
  closeOverlay: () => void
  overlayRef: RefObject<OverlayReason | null>
}

export interface SignerPrompts {
  signerRequest: SignerRequest | null
  signerWaiting: number
  passkeyConfirmation: PasskeyConfirmationRequest | null
  respondToSigner: (allow: boolean, remember: boolean) => void
  respondToPasskeyConfirmation: (choice: number | null) => void
}

/** NIP-07 approvals and passkey confirmations, both queued one prompt at a time. */
export function useSignerPrompts({
  showOverlay,
  closeOverlay,
  overlayRef
}: Options): SignerPrompts {
  const [signerRequests, setSignerRequests] = useState<SignerRequest[]>([])
  const [passkeyConfirmations, setPasskeyConfirmations] = useState<PasskeyConfirmationRequest[]>([])
  const signerRequest = signerRequests[0] ?? null
  const passkeyConfirmation = passkeyConfirmations[0] ?? null

  useEffect(() => {
    const remember = (request: SignerRequest): void => {
      showOverlay(null)
      setSignerRequests((current) =>
        current.some((entry) => entry.id === request.id) ? current : [...current, request]
      )
    }

    const unsubscribe = window.ncc.onSignerRequest(remember)
    const offResolved = window.ncc.onSignerResolved((id) =>
      setSignerRequests((current) => current.filter((entry) => entry.id !== id))
    )

    // A request raised before this renderer mounted was sent to nobody; the broker
    // keeps it pending, so replay whatever it still has.
    void window.ncc
      .pendingSignerRequests()
      .then((pending) => pending.forEach(remember))
      .catch(() => undefined)

    return () => {
      unsubscribe()
      offResolved()
    }
  }, [showOverlay])

  useEffect(() => {
    const offRequest = window.ncc.onPasskeyConfirmation((request) => {
      setPasskeyConfirmations((current) =>
        current.some((item) => item.id === request.id) ? current : [...current, request]
      )
    })
    const offResolved = window.ncc.onPasskeyConfirmationResolved((id) => {
      setPasskeyConfirmations((current) => current.filter((item) => item.id !== id))
    })
    return () => {
      offRequest()
      offResolved()
    }
  }, [])

  useEffect(() => {
    if (passkeyConfirmation) showOverlay('passkey-confirmation')
    else if (overlayRef.current === 'passkey-confirmation') closeOverlay()
  }, [passkeyConfirmation, overlayRef, showOverlay, closeOverlay])

  const respondToSigner = useCallback(
    (allow: boolean, remember: boolean) => {
      if (!signerRequest) return
      setSignerRequests((current) => current.filter((entry) => entry.id !== signerRequest.id))
      void window.ncc.respondToSigner(signerRequest.id, allow, remember)
    },
    [signerRequest]
  )

  const respondToPasskeyConfirmation = useCallback(
    (choice: number | null) => {
      if (!passkeyConfirmation) return
      const id = passkeyConfirmation.id
      setPasskeyConfirmations((current) => current.filter((item) => item.id !== id))
      void window.ncc.respondToPasskeyConfirmation(id, choice)
    },
    [passkeyConfirmation]
  )

  return {
    signerRequest,
    signerWaiting: signerRequests.length - 1,
    passkeyConfirmation,
    respondToSigner,
    respondToPasskeyConfirmation
  }
}
