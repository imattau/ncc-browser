import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  emptyHostingState,
  MAX_HOSTED_TTL_SECONDS,
  MIN_HOSTED_TTL_SECONDS,
  normalizeEndpoint,
  receivedShareId,
  validateHostingDraft,
  validateServiceId,
  type HostedService,
  type HostingDraft,
  type HostingState,
  type ReceivedShare,
  type ServiceEndpoint,
  type ServiceShare,
  type ShareStatus
} from '@shared/hosting'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Hosted services and shares in `userData/services.json`.
 *
 * The file never contains key material: only public locators, endpoints and the share
 * recipient. Writes are atomic and `0600` so a crash cannot leave a half-written file.
 */
export class HostingStore {
  private cache: HostingState | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = nowSeconds
  ) {}

  state(): HostingState {
    return clone(this.ensure())
  }

  find(id: string): HostedService | null {
    return clone(this.ensure().services.find((service) => service.id === id) ?? null)
  }

  findShare(id: string): ServiceShare | null {
    return clone(this.ensure().shares.find((share) => share.id === id) ?? null)
  }

  findShareFor(serviceId: string, recipient: string): ServiceShare | null {
    const hex = recipient.toLowerCase()
    return clone(
      this.ensure().shares.find(
        (share) => share.serviceId === serviceId && share.recipient === hex
      ) ?? null
    )
  }

  sharesFor(serviceId: string): ServiceShare[] {
    return clone(this.ensure().shares.filter((share) => share.serviceId === serviceId))
  }

  create(draft: HostingDraft): HostedService {
    const normalized = validateHostingDraft(draft)
    if (!normalized.ok) throw new Error(normalized.error)
    const state = this.ensure()
    if (state.services.some((service) => service.service === normalized.value.service)) {
      throw new Error(`"${normalized.value.service}" is already published`)
    }
    const at = this.now()
    const service: HostedService = {
      id: randomBytes(8).toString('hex'),
      ...normalized.value,
      createdAt: at,
      updatedAt: at
    }
    state.services.push(service)
    this.flush()
    return clone(service)
  }

  update(id: string, draft: HostingDraft): HostedService {
    const state = this.ensure()
    const existing = state.services.find((service) => service.id === id)
    if (!existing) throw new Error('That service no longer exists')
    const requested = draft.service?.trim().toLowerCase()
    if (requested && requested !== existing.service) {
      throw new Error('The service name cannot change after it is published')
    }
    const normalized = validateHostingDraft({ ...draft, service: existing.service })
    if (!normalized.ok) throw new Error(normalized.error)
    const updated: HostedService = {
      ...existing,
      ...normalized.value,
      updatedAt: this.now()
    }
    state.services = state.services.map((service) => (service.id === id ? updated : service))
    this.flush()
    return clone(updated)
  }

  remove(id: string): void {
    const state = this.ensure()
    state.services = state.services.filter((service) => service.id !== id)
    state.shares = state.shares.filter((share) => share.serviceId !== id)
    this.flush()
  }

  markPublished(id: string, at: number = this.now()): void {
    const service = this.ensure().services.find((entry) => entry.id === id)
    if (!service) return
    service.lastPublishedAt = at
    delete service.lastPublishError
    this.flush()
  }

  setOwner(id: string, owner: string): void {
    const service = this.ensure().services.find((entry) => entry.id === id)
    if (!service || !/^[0-9a-f]{64}$/i.test(owner)) return
    service.owner = owner.toLowerCase()
    this.flush()
  }

  markPublishError(id: string, message: string): void {
    const service = this.ensure().services.find((entry) => entry.id === id)
    if (!service) return
    service.lastPublishError = message.slice(0, 500)
    this.flush()
  }

  markSharePublished(id: string, at: number = this.now()): void {
    const share = this.ensure().shares.find((entry) => entry.id === id)
    if (!share) return
    share.lastPublishedAt = at
    share.status = 'active'
    this.flush()
  }

  putShare(share: ServiceShare): ServiceShare {
    const state = this.ensure()
    const index = state.shares.findIndex((entry) => entry.id === share.id)
    if (index === -1) state.shares.push(share)
    else state.shares[index] = { ...state.shares[index], ...share }
    this.flush()
    return clone(state.shares[index === -1 ? state.shares.length - 1 : index])
  }

  removeShare(id: string): void {
    const state = this.ensure()
    state.shares = state.shares.filter((share) => share.id !== id)
    this.flush()
  }

  setShareStatus(id: string, status: ShareStatus): void {
    const share = this.ensure().shares.find((entry) => entry.id === id)
    if (!share) return
    share.status = status
    this.flush()
  }

  markShareRevoked(id: string, at: number = this.now()): void {
    const share = this.ensure().shares.find((entry) => entry.id === id)
    if (!share) return
    share.status = 'revoked'
    // Remember the tombstone's `created_at`: a later re-share must beat it.
    share.lastPublishedAt = at
    this.flush()
  }

  recordReceived(input: {
    owner: string
    ownerNpub: string
    dTag: string
    expiresAt: number
    title?: string
  }): ReceivedShare {
    const state = this.ensure()
    const owner = input.owner.toLowerCase()
    const id = receivedShareId(owner, input.dTag)
    const existing = state.received.find((entry) => entry.id === id)
    const at = this.now()
    const record: ReceivedShare = {
      id,
      owner,
      ownerNpub: input.ownerNpub || existing?.ownerNpub || '',
      dTag: input.dTag,
      ...(input.title ? { title: input.title.slice(0, 200) } : {}),
      expiresAt: input.expiresAt,
      firstSeenAt: existing?.firstSeenAt ?? at
    }
    if (existing) state.received = state.received.map((entry) => (entry.id === id ? record : entry))
    else state.received.push(record)
    this.flush()
    return clone(record)
  }

  forgetReceived(id: string): void {
    const state = this.ensure()
    state.received = state.received.filter((entry) => entry.id !== id)
    this.flush()
  }

  private ensure(): HostingState {
    this.cache ??= this.read()
    return this.cache
  }

  private read(): HostingState {
    if (!existsSync(this.filePath)) return emptyHostingState()
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<HostingState>
      if (!parsed || parsed.version !== 1) return emptyHostingState()
      return normalizeState(parsed, this.now())
    } catch (error) {
      console.warn('[hosting] ignoring unreadable services file:', error)
      return emptyHostingState()
    }
  }

  private flush(): void {
    const state = this.ensure()
    const data = `${JSON.stringify(state, null, 2)}\n`
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Best effort: some filesystems do not implement POSIX modes.
    }
  }
}

function normalizeState(parsed: Partial<HostingState>, now: number): HostingState {
  const services: HostedService[] = []
  const seen = new Set<string>()

  for (const raw of Array.isArray(parsed.services) ? parsed.services : []) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<HostedService>
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const service = validateServiceId(typeof candidate.service === 'string' ? candidate.service : '')
    if (!id || !service.ok || seen.has(service.value)) continue
    const endpoints: ServiceEndpoint[] = []
    for (const endpoint of Array.isArray(candidate.endpoints) ? candidate.endpoints : []) {
      const normalized = normalizeEndpoint(endpoint as ServiceEndpoint)
      if (normalized.ok) endpoints.push(normalized.value)
    }
    if (endpoints.length === 0) continue
    const visibility = candidate.visibility === 'public' ? 'public' : 'private'
    const ttl = Number(candidate.ttlSeconds)
    const createdAt = isTime(candidate.createdAt) ? candidate.createdAt : now
    const updatedAt = isTime(candidate.updatedAt) ? candidate.updatedAt : createdAt
    const record: HostedService = {
      id,
      service: service.value,
      ...(typeof candidate.owner === 'string' && /^[0-9a-f]{64}$/i.test(candidate.owner)
        ? { owner: candidate.owner.toLowerCase() }
        : {}),
      title:
        typeof candidate.title === 'string' && candidate.title.trim()
          ? candidate.title.trim().slice(0, 80)
          : service.value,
      endpoints,
      ttlSeconds: Number.isFinite(ttl)
        ? Math.min(MAX_HOSTED_TTL_SECONDS, Math.max(MIN_HOSTED_TTL_SECONDS, Math.round(ttl)))
        : 7 * 86_400,
      visibility,
      anchor: candidate.anchor === true,
      ...(typeof candidate.notes === 'string' && candidate.notes.trim()
        ? { notes: candidate.notes.trim().slice(0, 280) }
        : {}),
      createdAt,
      updatedAt,
      ...(isTime(candidate.lastPublishedAt) ? { lastPublishedAt: candidate.lastPublishedAt } : {}),
      ...(typeof candidate.lastPublishError === 'string'
        ? { lastPublishError: candidate.lastPublishError.slice(0, 500) }
        : {})
    }
    seen.add(service.value)
    services.push(record)
  }

  const serviceIds = new Set(services.map((service) => service.id))
  const shares: ServiceShare[] = []
  for (const raw of Array.isArray(parsed.shares) ? parsed.shares : []) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<ServiceShare>
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.serviceId !== 'string' ||
      !serviceIds.has(candidate.serviceId) ||
      typeof candidate.dTag !== 'string' ||
      !candidate.dTag.startsWith('share-') ||
      typeof candidate.recipient !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(candidate.recipient) ||
      !isTime(candidate.expiresAt)
    ) {
      continue
    }
    const status: ShareStatus =
      candidate.status === 'revoked' ? 'revoked' : candidate.expiresAt <= now ? 'expired' : 'active'
    shares.push({
      id: candidate.id,
      serviceId: candidate.serviceId,
      dTag: candidate.dTag,
      recipient: candidate.recipient.toLowerCase(),
      recipientNpub: typeof candidate.recipientNpub === 'string' ? candidate.recipientNpub : '',
      ...(typeof candidate.label === 'string' && candidate.label.trim()
        ? { label: candidate.label.trim().slice(0, 80) }
        : {}),
      expiresAt: candidate.expiresAt,
      createdAt: isTime(candidate.createdAt) ? candidate.createdAt : now,
      ...(isTime(candidate.lastPublishedAt) ? { lastPublishedAt: candidate.lastPublishedAt } : {}),
      status
    })
  }

  const received: ReceivedShare[] = []
  for (const raw of Array.isArray(parsed.received) ? parsed.received : []) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<ReceivedShare>
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.owner !== 'string' ||
      typeof candidate.dTag !== 'string' ||
      !candidate.dTag.startsWith('share-') ||
      !isTime(candidate.expiresAt)
    ) {
      continue
    }
    received.push({
      id: candidate.id,
      owner: candidate.owner.toLowerCase(),
      ownerNpub: typeof candidate.ownerNpub === 'string' ? candidate.ownerNpub : '',
      dTag: candidate.dTag,
      ...(typeof candidate.title === 'string' ? { title: candidate.title.slice(0, 200) } : {}),
      expiresAt: candidate.expiresAt,
      firstSeenAt: isTime(candidate.firstSeenAt) ? candidate.firstSeenAt : now
    })
  }

  return { version: 1, services, shares, received }
}
