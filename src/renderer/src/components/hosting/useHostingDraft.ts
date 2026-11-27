import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_HOSTED_TTL_SECONDS,
  certificateCoversHost,
  servicesForLocalUrl,
  type CertificateInfo,
  type HostedService,
  type HostingDraft,
  type HostingState
} from '@shared/hosting'
import {
  normalizeEndpointSeed,
  type EndpointCandidate,
  type PortMapping,
  type ReachabilityReport
} from '@shared/reachability'
import { messageOf } from '../../lib/format'
import {
  discardServiceDraft,
  editServiceDraft,
  openServiceDraft,
  parkServiceDraft,
  restoreServiceDraft,
  serviceDraft,
  setServiceDraftExtras,
  type PrefillDraft,
  type UnfinishedService
} from './serviceDraft'
import { EMPTY_DRAFT, type DraftState, type HostingFeedback } from './types'

type Feedback = Pick<HostingFeedback, 'apply' | 'busy' | 'setBusy' | 'setError'>

interface Options {
  feedback: Feedback
  strictAnchors: boolean
  state: HostingState | null
  /** The active identity's pubkey; `undefined` until the identity has loaded. */
  owner: string | null | undefined
  openShare: (serviceId: string) => void
  resetShares: () => void
  dismissPortAlert: (localPort: number) => void
  initialDraft?: PrefillDraft | null
  onDraftUsed?: () => void
}

export interface HostingDraftApi {
  draft: DraftState | null
  /** The kept form, whether it is open or set aside. */
  unfinished: UnfinishedService | null
  /** What may have changed since the form was last open. */
  warnings: string[]
  setStep: (step: number) => void
  setWantTor: (wantTor: boolean) => void
  /** Set the form aside without losing it. */
  park: () => void
  resume: () => void
  /** Throw the form away, asking first if there is something in it. */
  discard: () => void
  /** Set when "Publish this page" found services that already use that server. */
  existing: HostedService[]
  patchDraft: (patch: Partial<DraftState>) => void
  cancelDraft: () => void
  startCreate: () => void
  startEdit: (service: HostedService) => void
  submit: () => Promise<void>
  discovery: ReachabilityReport | null
  discoveryBusy: boolean
  discoveryError: string | null
  discoveryPort: string
  setDiscoveryPort: (value: string) => void
  localOnly: boolean
  localEndpoint: EndpointCandidate | null
  externalCandidate: EndpointCandidate | null
  visibleCandidates: EndpointCandidate[]
  discover: (
    seed: string,
    options?: { external?: boolean; port?: number; secure?: boolean }
  ) => Promise<void>
  setLocalNetworkOnly: (value: boolean) => void
  toggleEndpoint: (url: string) => void
  mapping: PortMapping | null
  mappingBusy: boolean
  verifyBusy: boolean
  mapPort: () => Promise<void>
  unmapPort: () => Promise<void>
  verifyMapping: () => Promise<void>
  recheckPort: (localPort: number) => Promise<void>
  certificateInfo: CertificateInfo | null
  certificatePaths: { certPath: string; keyPath: string } | null
  certificateBusy: boolean
  importCertificate: () => Promise<void>
  generateCertificate: () => Promise<void>
  clearCertificate: () => void
}

/** What saving a draft sends. Typed addresses without a scheme get `http://`. */
export function servicePayload(draft: DraftState, strictAnchors: boolean): HostingDraft {
  const endpoints = draft.endpoints
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const url = normalizeEndpointSeed(line) ?? line
      const pin = draft.pins[line] ?? draft.pins[url]
      return pin ? { url, k: pin, priority: 1000 } : url
    })
  return {
    title: draft.title,
    ...(draft.id ? {} : draft.service.trim() ? { service: draft.service } : {}),
    endpoints,
    ttlSeconds: Math.max(1, Number(draft.ttlDays) || 7) * 86_400,
    visibility: draft.visibility,
    anchor: strictAnchors ? true : draft.anchor,
    notes: draft.notes
  }
}

/** Before another form takes its place, ask about one with something in it. */
function mayReplace(): boolean {
  const entry = serviceDraft.get()
  if (!entry?.dirty) return true
  const name = entry.draft.title.trim() || 'Unnamed service'
  return window.confirm(`You haven’t finished “${name}”. Discard it and start another?`)
}

/**
 * The service form: draft state, endpoint discovery, router port mapping and TLS
 * certificate pinning. All of these edit the same draft, so they share one hook.
 */
export function useHostingDraft(options: Options): HostingDraftApi {
  const {
    feedback,
    strictAnchors,
    state,
    owner,
    openShare,
    resetShares,
    dismissPortAlert,
    initialDraft,
    onDraftUsed
  } = options
  const { apply, setBusy, setError } = feedback

  const unfinished = serviceDraft.use()
  const draft = unfinished && !unfinished.parked ? unfinished.draft : null
  const [restored, setRestored] = useState(false)
  /** Mapped ports that exist now; `null` until asked. */
  const [mappings, setMappings] = useState<PortMapping[] | null>(null)
  // Writes go to the kept form, so work that finishes after this screen has gone
  // (a certificate, a port mapping) is not lost.
  const setDraft = (change: (current: DraftState | null) => DraftState | null): void =>
    editServiceDraft((current) => change(current) ?? current)

  useEffect(() => {
    let alive = true
    void restoreServiceDraft().then(() => alive && setRestored(true))
    void window.ncc
      .hostingPortMappings()
      .then((list) => {
        if (!alive) return
        setMappings(list)
        // Show the controls again for a mapping this form made earlier.
        const url = serviceDraft.get()?.mappedUrl
        const live = list.find((entry) => entry.url === url)
        if (live) setMapping(live)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // An edit of a service that has since been removed has nothing to save to.
  useEffect(() => {
    const id = unfinished?.draft.id
    if (state && id && !state.services.some((service) => service.id === id)) {
      discardServiceDraft(unfinished.key)
    }
  }, [state, unfinished])
  const [existingIds, setExistingIds] = useState<string[]>([])
  const [discovery, setDiscovery] = useState<ReachabilityReport | null>(null)
  const [discoveryBusy, setDiscoveryBusy] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [discoveryPort, setDiscoveryPort] = useState('')
  const [localOnly, setLocalOnly] = useState(false)
  const [mapping, setMapping] = useState<PortMapping | null>(null)
  const [mappingBusy, setMappingBusy] = useState(false)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const certificateInfo = unfinished?.certificate?.info ?? null
  const certificatePaths = unfinished?.certificate?.paths ?? null
  const [certificateBusy, setCertificateBusy] = useState(false)

  const patchDraft = (patch: Partial<DraftState>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const discover = useCallback(
    async (
      seed: string,
      options: { external?: boolean; port?: number; secure?: boolean } = {}
    ): Promise<void> => {
      const target = seed.trim()
      if (target && !normalizeEndpointSeed(target)) {
        setDiscoveryError('Enter an endpoint as IP:port or http(s)://…')
        return
      }
      setDiscoveryBusy(true)
      setDiscoveryError(null)
      try {
        setDiscovery(
          await window.ncc.hostingDiscoverEndpoints(target, {
            ...(options.external ? { external: true } : {}),
            ...(options.port === undefined ? {} : { port: options.port }),
            ...(options.secure ? { secure: true } : {})
          })
        )
      } catch (discoverFailure) {
        setDiscoveryError(messageOf(discoverFailure))
      } finally {
        setDiscoveryBusy(false)
      }
    },
    []
  )

  const localEndpoint = useMemo(() => {
    return discovery?.candidates.find((candidate) => candidate.kind === 'loopback') ?? null
  }, [discovery])

  const externalCandidate = useMemo(() => {
    return discovery?.candidates.find((candidate) => candidate.source === 'external') ?? null
  }, [discovery])

  const visibleCandidates = useMemo(() => {
    if (!discovery) return []
    return discovery.candidates.filter((candidate) => {
      if (candidate.source === 'external') return false
      if (!localOnly) return true
      return candidate.kind !== 'public-v4' && candidate.kind !== 'current-https'
    })
  }, [discovery, localOnly])

  const setLocalNetworkOnly = (value: boolean): void => {
    setLocalOnly(value)
    if (!value || !discovery) return
    const publicUrls = new Set(
      discovery.candidates
        .filter((candidate) => candidate.kind === 'public-v4' || candidate.kind === 'current-https')
        .map((candidate) => candidate.url)
    )
    setDraft((current) => {
      if (!current) return current
      const lines = current.endpoints
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !publicUrls.has(line))
      const pins = { ...current.pins }
      for (const url of publicUrls) delete pins[url]
      return { ...current, endpoints: lines.join('\n'), pins }
    })
  }

  const mapPort = async (): Promise<void> => {
    if (!localEndpoint) return
    let url: URL
    try {
      url = new URL(localEndpoint.url)
    } catch {
      return
    }
    const localPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (
      !window.confirm(
        `Ask the router to forward TCP port ${localPort} to this machine over UPnP?\n\n` +
          'The mapping is limited to this port, described as Nostr Navigator, expires after two hours and is removed when the browser quits.'
      )
    ) {
      return
    }
    setMappingBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingMapPort({
        localPort,
        secure: url.protocol === 'https:'
      })
      setMapping(result)
      setServiceDraftExtras({ mappedUrl: result.url })
      setDraft((current) => {
        if (!current) return current
        const lines = current.endpoints.split('\n').map((line) => line.trim()).filter(Boolean)
        return lines.includes(result.url)
          ? current
          : { ...current, endpoints: [...lines, result.url].join('\n') }
      })
    } catch (mappingError) {
      setError(messageOf(mappingError))
    } finally {
      setMappingBusy(false)
    }
  }

  const unmapPort = async (): Promise<void> => {
    if (!mapping) return
    setMappingBusy(true)
    try {
      await window.ncc.hostingUnmapPort(mapping.localPort)
      setDraft((current) =>
        current
          ? {
              ...current,
              endpoints: current.endpoints
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line && line !== mapping.url)
                .join('\n')
            }
          : current
      )
      setMapping(null)
      setServiceDraftExtras({ mappedUrl: null })
    } catch (mappingError) {
      setError(messageOf(mappingError))
    } finally {
      setMappingBusy(false)
    }
  }

  const applyCertificate = (info: CertificateInfo): void => {
    setDraft((current) => {
      if (!current) return current
      const lines = current.endpoints
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (lines.length === 0) {
        setError('Add an endpoint before choosing a certificate')
        return current
      }
      const uncovered: string[] = []
      const pins: Record<string, string> = { ...current.pins }
      const nextLines = lines.map((line) => {
        const normalized = normalizeEndpointSeed(line)
        if (!normalized) return line
        try {
          const url = new URL(normalized)
          const host = url.hostname.replace(/^\[|\]$/g, '')
          if (!certificateCoversHost(info, host)) {
            uncovered.push(host)
            return line
          }
          url.protocol = 'https:'
          const secure = url.toString()
          pins[secure] = info.pin
          return secure
        } catch {
          return line
        }
      })
      if (uncovered.length > 0) {
        setError(
          `The certificate does not name ${[...new Set(uncovered)].join(', ')}; those endpoints were left unchanged.`
        )
      }
      return { ...current, endpoints: nextLines.join('\n'), pins }
    })
    setServiceDraftExtras({ certificate: { info, paths: null } })
  }

  const importCertificate = async (): Promise<void> => {
    setCertificateBusy(true)
    setError(null)
    try {
      const info = await window.ncc.hostingImportCertificate()
      if (info) applyCertificate(info)
    } catch (certificateError) {
      setError(messageOf(certificateError))
    } finally {
      setCertificateBusy(false)
    }
  }

  const generateCertificate = async (): Promise<void> => {
    if (!draft) return
    const hosts = draft.endpoints
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const normalized = normalizeEndpointSeed(line)
        if (!normalized) return []
        try {
          return [new URL(normalized).hostname.replace(/^\[|\]$/g, '')]
        } catch {
          return []
        }
      })
    const commonName = hosts[0]
    if (!commonName) {
      setError('Add an endpoint first so the certificate has a name')
      return
    }
    setCertificateBusy(true)
    setError(null)
    try {
      const generated = await window.ncc.hostingGenerateCertificate({
        commonName,
        altNames: [...new Set(hosts)]
      })
      if (generated) {
        applyCertificate(generated)
        setServiceDraftExtras({
          certificate: {
            info: generated,
            paths: { certPath: generated.certPath, keyPath: generated.keyPath }
          }
        })
      }
    } catch (certificateError) {
      setError(messageOf(certificateError))
    } finally {
      setCertificateBusy(false)
    }
  }

  const clearCertificate = (): void => {
    setDraft((current) => (current ? { ...current, pins: {} } : current))
    setServiceDraftExtras({ certificate: null })
  }

  const verifyMapping = async (): Promise<void> => {
    if (!mapping) return
    setVerifyBusy(true)
    setError(null)
    try {
      const updated = await window.ncc.hostingVerifyPort(mapping.localPort)
      if (updated) setMapping(updated)
      if (!updated?.verifiedAt) {
        setError(
          'The mapped port did not answer through Tor. Check the router forward and that the service is running.'
        )
      }
    } catch (verifyError) {
      setError(messageOf(verifyError))
    } finally {
      setVerifyBusy(false)
    }
  }

  const recheckPort = async (localPort: number): Promise<void> => {
    setVerifyBusy(true)
    setError(null)
    try {
      const updated = await window.ncc.hostingVerifyPort(localPort)
      if (updated?.verifiedAt) {
        dismissPortAlert(localPort)
        if (mapping?.localPort === localPort) setMapping(updated)
      } else {
        setError('The port still does not answer through Tor.')
      }
    } catch (verifyError) {
      setError(messageOf(verifyError))
    } finally {
      setVerifyBusy(false)
    }
  }

  const toggleEndpoint = (url: string): void => {
    setDraft((current) => {
      if (!current) return current
      const lines = current.endpoints
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const adding = !lines.includes(url)
      const next = adding ? [...lines, url] : lines.filter((line) => line !== url)
      const pins = { ...current.pins }
      if (adding && certificateInfo) {
        const normalized = normalizeEndpointSeed(url)
        if (normalized) {
          try {
            const host = new URL(normalized).hostname.replace(/^\[|\]$/g, '')
            if (certificateCoversHost(certificateInfo, host)) pins[url] = certificateInfo.pin
          } catch {
            // leave the candidate unpinned
          }
        }
      } else if (!adding) {
        delete pins[url]
      }
      return { ...current, endpoints: next.join('\n'), pins }
    })
  }

  useEffect(() => {
    // Wait for the saved services and the identity, or the check below would miss a
    // service and a second one would be started for the same server.
    // The kept form has to be back first, or this could replace it without asking.
    if (!initialDraft || !state || !restored || owner === undefined) return
    const draftEndpoints = initialDraft.endpoints ?? []
    const urls = draftEndpoints.map((endpoint) =>
      typeof endpoint === 'string' ? endpoint : endpoint.url
    )
    const matches = [
      ...new Set(urls.flatMap((url) => servicesForLocalUrl(state, url, owner).map(({ id }) => id)))
    ]
    setExistingIds(matches)
    if (matches.length > 0) {
      // Put any open form aside so the services it points to are in view.
      parkServiceDraft(true)
      if (!serviceDraft.get()?.dirty) discardServiceDraft()
      onDraftUsed?.()
      return
    }
    if (!mayReplace()) {
      parkServiceDraft(false)
      onDraftUsed?.()
      return
    }
    openServiceDraft(
      {
      ...EMPTY_DRAFT,
      title: initialDraft.title,
      service: initialDraft.service ?? '',
      endpoints: draftEndpoints
        .map((endpoint) => (typeof endpoint === 'string' ? endpoint : endpoint.url))
        .join('\n'),
      pins: Object.fromEntries(
        draftEndpoints.flatMap((endpoint) =>
          typeof endpoint !== 'string' && endpoint.k ? [[endpoint.url, endpoint.k]] : []
        )
      ),
      ttlDays: String(
        Math.max(1, Math.round((initialDraft.ttlSeconds ?? DEFAULT_HOSTED_TTL_SECONDS) / 86_400))
      ),
      visibility: initialDraft.visibility ?? 'private',
      anchor: initialDraft.anchor === true,
      notes: initialDraft.notes ?? ''
      },
      { memoryOnly: initialDraft.fromPrivateTab === true }
    )
    const seed = urls.find(Boolean)
    if (seed && normalizeEndpointSeed(seed)) void discover(seed)
    onDraftUsed?.()
  }, [initialDraft, state, restored, owner, onDraftUsed, discover])

  const resetTools = (): void => {
    setError(null)
    resetShares()
    setDiscovery(null)
    setDiscoveryError(null)
  }

  const startCreate = (): void => {
    if (!mayReplace()) return
    openServiceDraft({ ...EMPTY_DRAFT })
    setExistingIds([])
    resetTools()
  }

  const startEdit = (service: HostedService): void => {
    // Going back to a service with unsaved changes picks them up again.
    if (serviceDraft.get()?.draft.id === service.id) {
      parkServiceDraft(false)
      return
    }
    if (!mayReplace()) return
    openServiceDraft(
      {
        id: service.id,
        title: service.title,
        service: service.service,
        endpoints: service.endpoints.map((endpoint) => endpoint.url).join('\n'),
        pins: Object.fromEntries(
          service.endpoints.flatMap((endpoint) => (endpoint.k ? [[endpoint.url, endpoint.k]] : []))
        ),
        ttlDays: String(Math.max(1, Math.round(service.ttlSeconds / 86_400))),
        visibility: service.visibility,
        anchor: service.anchor,
        notes: service.notes ?? ''
      },
      { baseUpdatedAt: service.updatedAt }
    )
    resetTools()
  }

  const discard = (): void => {
    const entry = serviceDraft.get()
    if (!entry) return
    const question = entry.draft.id
      ? 'Discard your unsaved changes to this service?'
      : 'Discard this unfinished service? What you entered will be lost.'
    if (entry.dirty && !window.confirm(question)) return
    discardServiceDraft(entry.key)
  }

  const warnings: string[] = []
  if (unfinished) {
    const edited = state?.services.find((service) => service.id === unfinished.draft.id)
    if (edited && unfinished.baseUpdatedAt && edited.updatedAt !== unfinished.baseUpdatedAt) {
      warnings.push(
        'This service has changed since you started editing. Saving replaces those changes.'
      )
    }
    const { mappedUrl } = unfinished
    if (
      mappedUrl &&
      mappings &&
      mapping?.url !== mappedUrl &&
      !mappings.some((entry) => entry.url === mappedUrl) &&
      unfinished.draft.endpoints.includes(mappedUrl)
    ) {
      warnings.push(
        `The router no longer forwards ${mappedUrl}. Map the port again, or remove that address.`
      )
    }
  }

  /** Save changes to an existing service. New ones are saved by the wizard. */
  const submit = async (): Promise<void> => {
    if (!draft?.id) return
    if (!draft.title.trim()) return setError('Give the service a name')
    setBusy(true)
    setError(null)
    try {
      const payload = servicePayload(draft, strictAnchors)
      const key = serviceDraft.get()?.key
      apply(await window.ncc.hostingUpdate(draft.id, payload))
      discardServiceDraft(key)
      // Show who has access after editing a published service, so the contact list is
      // there without a second trip to the card. An unpublished one needs publishing
      // first, which its card says.
      const published = state?.services.some(
        (service) => service.id === draft.id && service.lastPublishedAt
      )
      if (published && payload.visibility === 'private') openShare(draft.id)
    } catch (submitError) {
      setError(messageOf(submitError))
    } finally {
      setBusy(false)
    }
  }

  return {
    draft,
    unfinished,
    warnings,
    setStep: (step) => setServiceDraftExtras({ step }),
    setWantTor: (wantTor) => setServiceDraftExtras({ wantTor }),
    park: () => parkServiceDraft(true),
    resume: () => {
      resetTools()
      parkServiceDraft(false)
    },
    discard,
    existing: state?.services.filter((service) => existingIds.includes(service.id)) ?? [],
    patchDraft,
    cancelDraft: () => discardServiceDraft(),
    startCreate,
    startEdit,
    submit,
    discovery,
    discoveryBusy,
    discoveryError,
    discoveryPort,
    setDiscoveryPort,
    localOnly,
    localEndpoint,
    externalCandidate,
    visibleCandidates,
    discover,
    setLocalNetworkOnly,
    toggleEndpoint,
    mapping,
    mappingBusy,
    verifyBusy,
    mapPort,
    unmapPort,
    verifyMapping,
    recheckPort,
    certificateInfo,
    certificatePaths,
    certificateBusy,
    importCertificate,
    generateCertificate,
    clearCertificate
  }
}
