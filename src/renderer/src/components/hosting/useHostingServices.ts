import type { HostedService } from '@shared/hosting'
import { messageOf } from '../../lib/format'
import type { HostingFeedback } from './types'

type Feedback = Pick<HostingFeedback, 'apply' | 'setBusy' | 'setError'>

interface Options {
  feedback: Feedback
  draftId?: string
  clearDraft: () => void
}

export interface HostingServicesApi {
  publish: (service: HostedService) => Promise<void>
  remove: (service: HostedService) => Promise<void>
  publishOnion: (service: HostedService) => Promise<void>
  removeOnion: (service: HostedService) => Promise<void>
}

/** Publish and remove actions for an existing service. */
export function useHostingServices({
  feedback,
  draftId,
  clearDraft
}: Options): HostingServicesApi {
  const { apply, setBusy, setError } = feedback

  const publish = async (service: HostedService): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingPublish(service.id)
      if (!result.ok) setError(`Published to ${result.accepted} of ${result.relays} relays`)
      apply(await window.ncc.hostingState())
    } catch (publishError) {
      setError(messageOf(publishError))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (service: HostedService): Promise<void> => {
    if (!window.confirm(`Remove "${service.title}" and its shares from this browser?`)) return
    setBusy(true)
    try {
      apply(await window.ncc.hostingRemove(service.id))
      if (draftId === service.id) clearDraft()
    } catch (removeError) {
      setError(messageOf(removeError))
    } finally {
      setBusy(false)
    }
  }

  const publishOnion = async (service: HostedService): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingPublishOnion(service.id)
      apply(result.state)
    } catch (onionError) {
      setError(messageOf(onionError))
    } finally {
      setBusy(false)
    }
  }

  const removeOnion = async (service: HostedService): Promise<void> => {
    if (
      !window.confirm(
        'Remove the onion endpoint? The onion address stops working and its key is deleted.'
      )
    ) {
      return
    }
    setBusy(true)
    try {
      apply(await window.ncc.hostingRemoveOnion(service.id))
    } catch (onionError) {
      setError(messageOf(onionError))
    } finally {
      setBusy(false)
    }
  }

  return { publish, remove, publishOnion, removeOnion }
}
