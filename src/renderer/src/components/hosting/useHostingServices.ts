import { useState } from 'react'
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
  /** The service being worked on, and what is happening to it. */
  activity: { id: string; label: string } | null
  /** Why the last action on one service failed. */
  failure: { id: string; message: string } | null
  publish: (service: HostedService) => Promise<void>
  remove: (service: HostedService) => Promise<void>
  publishOnion: (service: HostedService) => Promise<void>
  removeOnion: (service: HostedService) => Promise<void>
  publishTlsProxy: (service: HostedService) => Promise<void>
  removeTlsProxy: (service: HostedService) => Promise<void>
}

/** Publish and remove actions for an existing service. */
export function useHostingServices({
  feedback,
  draftId,
  clearDraft
}: Options): HostingServicesApi {
  const { apply, setBusy, setError } = feedback

  const [activity, setActivity] = useState<HostingServicesApi['activity']>(null)
  const [failure, setFailure] = useState<HostingServicesApi['failure']>(null)

  /** Run one slow action, reporting progress and errors on the service's own card. */
  const track = async (
    service: HostedService,
    label: string,
    action: () => Promise<void>
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    setFailure(null)
    setActivity({ id: service.id, label })
    try {
      await action()
    } catch (actionError) {
      setFailure({ id: service.id, message: messageOf(actionError) })
    } finally {
      setActivity(null)
      setBusy(false)
    }
  }

  const publish = (service: HostedService): Promise<void> =>
    track(service, 'Publishing…', async () => {
      const result = await window.ncc.hostingPublish(service.id)
      apply(await window.ncc.hostingState())
      if (!result.ok) throw new Error(`Published to ${result.accepted} of ${result.relays} relays`)
    })

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

  const publishOnion = (service: HostedService): Promise<void> =>
    track(service, 'Creating a Tor address. This can take a minute or two…', async () => {
      apply((await window.ncc.hostingPublishOnion(service.id)).state)
    })

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

  const publishTlsProxy = (service: HostedService): Promise<void> =>
    track(service, 'Setting up HTTPS…', async () => {
      apply((await window.ncc.hostingPublishTlsProxy(service.id)).state)
    })

  const removeTlsProxy = async (service: HostedService): Promise<void> => {
    if (
      !window.confirm(
        'Turn off HTTPS? Its https:// addresses stop working. Publish again to send your saved addresses.'
      )
    ) {
      return
    }
    setBusy(true)
    try {
      apply(await window.ncc.hostingRemoveTlsProxy(service.id))
    } catch (proxyError) {
      setError(messageOf(proxyError))
    } finally {
      setBusy(false)
    }
  }

  return { activity, failure, publish, remove, publishOnion, removeOnion, publishTlsProxy, removeTlsProxy }
}
