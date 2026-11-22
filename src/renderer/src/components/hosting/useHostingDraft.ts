import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_HOSTED_TTL_SECONDS,
  certificateCoversHost,
  type CertificateInfo,
  type HostedService,
  type HostingDraft
} from '@shared/hosting'
import {
  normalizeEndpointSeed,
  type EndpointCandidate,
  type PortMapping,
  type ReachabilityReport
} from '@shared/reachability'
import { messageOf } from '../../lib/format'
import { EMPTY_DRAFT, type DraftState, type HostingFeedback } from './types'

type Feedback = Pick<HostingFeedback, 'apply' | 'busy' | 'setBusy' | 'setError'>

interface Options {
  feedback: Feedback
  strictAnchors: boolean
  services: HostedService[]
  openShare: (serviceId: string) => void
  resetShares: () => void
  dismissPortAlert: (localPort: number) => void
  initialDraft?: HostingDraft | null
  onDraftUsed?: () => void
}

export interface HostingDraftApi {
  draft: DraftState | null
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

/**
 * The service form: draft state, endpoint discovery, router port mapping and TLS
 * certificate pinning. All of these edit the same draft, so they share one hook.
 */
export function useHostingDraft(options: Options): HostingDraftApi {
  const {
    feedback,
    strictAnchors,
    services,
    openShare,
    resetShares,
    dismissPortAlert,
    initialDraft,
    onDraftUsed
  } = options
  const { apply, setBusy, setError } = feedback

  const [draft, setDraft] = useState<DraftState | null>(null)
  const [discovery, setDiscovery] = useState<ReachabilityReport | null>(null)
  const [discoveryBusy, setDiscoveryBusy] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [discoveryPort, setDiscoveryPort] = useState('')
  const [localOnly, setLocalOnly] = useState(false)
  const [mapping, setMapping] = useState<PortMapping | null>(null)
  const [mappingBusy, setMappingBusy] = useState(false)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [certificateInfo, setCertificateInfo] = useState<CertificateInfo | null>(null)
  const [certificatePaths, setCertificatePaths] = useState<{
    certPath: string
    keyPath: string
  } | null>(null)
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
    setCertificateInfo(info)
    setCertificatePaths(null)
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
        setCertificatePaths({ certPath: generated.certPath, keyPath: generated.keyPath })
      }
    } catch (certificateError) {
      setError(messageOf(certificateError))
    } finally {
      setCertificateBusy(false)
    }
  }

  const clearCertificate = (): void => {
    setDraft((current) => (current ? { ...current, pins: {} } : current))
    setCertificateInfo(null)
    setCertificatePaths(null)
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
    if (!initialDraft) return
    const draftEndpoints = initialDraft.endpoints ?? []
    setDraft({
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
    })
    const seed = draftEndpoints
      .map((endpoint) => (typeof endpoint === 'string' ? endpoint : endpoint.url))
      .find(Boolean)
    if (seed && normalizeEndpointSeed(seed)) void discover(seed)
    onDraftUsed?.()
  }, [initialDraft, onDraftUsed, discover])

  const startCreate = (): void => {
    setDraft({ ...EMPTY_DRAFT })
    setError(null)
    resetShares()
    setDiscovery(null)
    setDiscoveryError(null)
  }

  const startEdit = (service: HostedService): void => {
    setDraft({
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
    })
    setError(null)
    resetShares()
    setDiscovery(null)
    setDiscoveryError(null)
  }

  const submit = async (): Promise<void> => {
    if (!draft) return
    const endpoints = draft.endpoints
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const pin = draft.pins[line]
        return pin ? { url: line, k: pin, priority: 1000 } : line
      })
    if (!draft.title.trim()) return setError('Give the service a name')
    setBusy(true)
    setError(null)
    try {
      const payload = {
        title: draft.title,
        ...(draft.id ? {} : draft.service.trim() ? { service: draft.service } : {}),
        endpoints,
        ttlSeconds: Math.max(1, Number(draft.ttlDays) || 7) * 86_400,
        visibility: draft.visibility,
        anchor: strictAnchors ? true : draft.anchor,
        notes: draft.notes
      }
      const creating = !draft.id
      const next = draft.id
        ? await window.ncc.hostingUpdate(draft.id, payload)
        : await window.ncc.hostingCreate(payload)
      apply(next)
      setDraft(null)
      if (creating && payload.visibility === 'private') {
        // A new private service has no Share panel yet. Open it immediately so the
        // contact list is visible without a second trip to the card.
        const created = next.services.find(
          (service) => !services.some((existing) => existing.id === service.id)
        )
        if (created) openShare(created.id)
      }
    } catch (submitError) {
      setError(messageOf(submitError))
    } finally {
      setBusy(false)
    }
  }

  return {
    draft,
    patchDraft,
    cancelDraft: () => setDraft(null),
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
