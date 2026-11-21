import { randomBytes } from 'node:crypto'
import { nip19, verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import type {
  HostedService,
  HostingDraft,
  HostingPublishReport,
  HostingPublishResult,
  HostingShareBatchResult,
  HostingShareResult,
  HostingState,
  ReceivedShare,
  ServiceShare
} from '@shared/hosting'
import {
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  MIN_SHARE_DAYS,
  isLoopbackEndpoint,
  parseRecipient,
  recipientNpub,
  serviceAddress,
  shareDTag,
  shareExpiry,
  shareStatus
} from '@shared/hosting'
import {
  buildAnchorTemplate,
  buildLocatorPayload,
  buildLocatorTemplate,
  buildTombstoneTemplate,
  locatorContent,
  sharePayload
} from '@shared/hosting-events'
import type { HostingStore } from './store'

export type HostingErrorCode =
  | 'identity-required'
  | 'not-found'
  | 'invalid-recipient'
  | 'public-service'
  | 'loopback-share'
  | 'wrong-identity'
  | 'publish-failed'
  | 'signer-failed'

export class HostingError extends Error {
  constructor(
    readonly code: HostingErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'HostingError'
  }
}

export interface HostingProvider {
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<Event>
  nip44Encrypt(peer: string, plaintext: string): Promise<string>
}

export interface HostingIdentity {
  provider(): HostingProvider | null
  status(): { configured: boolean; mode: string; hexPubkey?: string; npub?: string }
}

export type PublishReport = HostingPublishReport

export interface HostingPublisher {
  relaysFor(ownerHex: string): Promise<string[]>
  publish(event: Event, relays: string[]): Promise<PublishReport>
}

export type { HostingPublishResult, HostingShareResult }

export interface HostingServiceOptions {
  store: HostingStore
  identity: HostingIdentity
  publisher: HostingPublisher
  /** Settings → General → Require NCC-02 service records. */
  anchorRequired?: () => boolean
  now?: () => number
  onChange?: (state: HostingState) => void
}

const ANCHOR_DAYS = 14

/**
 * Publishing and sharing for hosted services.
 *
 * The canonical locator is encrypted to the owner by default; a share is the same
 * payload NIP-44 encrypted to one recipient under a distinct, reserved `d` tag. All
 * signing goes through the active identity provider, so a local key and a NIP-46
 * signer behave the same.
 */
export class HostingService {
  private readonly now: () => number

  constructor(private readonly options: HostingServiceOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  state(): HostingState {
    const state = this.options.store.state()
    const now = this.now()
    state.shares = state.shares.map((share) => ({
      ...share,
      status: shareStatus(share, now)
    }))
    return state
  }

  create(draft: HostingDraft): HostedService {
    const service = this.options.store.create(draft)
    this.changed()
    return service
  }

  update(id: string, draft: HostingDraft): HostedService {
    const service = this.options.store.update(id, draft)
    this.changed()
    return service
  }

  remove(id: string): void {
    this.options.store.remove(id)
    this.changed()
  }

  async publish(id: string): Promise<HostingPublishResult> {
    const service = this.options.store.find(id)
    if (!service) throw new HostingError('not-found', 'That service no longer exists')
    const { provider, hex } = await this.requireIdentity()
    this.assertOwner(service, hex)
    if (!service.owner) this.options.store.setOwner(id, hex)
    const now = this.now()
    // A replaceable record must be strictly newer than the one it replaces; the
    // resolver breaks equal `created_at` values by event id, which would otherwise
    // let a renewal or a revocation lose to the record it was meant to replace.
    const createdAt = Math.max(now, (service.lastPublishedAt ?? 0) + 1)

    const payload = buildLocatorPayload(service.endpoints, service.ttlSeconds, createdAt, service.notes)
    const json = locatorContent(payload)
    const content =
      service.visibility === 'private' ? await provider.nip44Encrypt(hex, json) : json
    const template = buildLocatorTemplate({
      dTag: service.service,
      ttlSeconds: service.ttlSeconds,
      content,
      now: createdAt,
      privateTag: service.visibility === 'private'
    })
    const event = await this.sign(provider, template)
    const relays = await this.relays(hex)
    const strict = this.options.anchorRequired?.() === true
    const needsAnchor = strict || service.anchor
    let anchorReport: PublishReport | null = null

    if (needsAnchor) {
      const anchor = buildAnchorTemplate({
        service: service.service,
        endpoint:
          service.endpoints.find((endpoint) => endpoint.url.startsWith('https://')) ??
          service.endpoints[0],
        days: ANCHOR_DAYS,
        now: createdAt,
        privateMode: service.visibility === 'private'
      })
      if (!anchor) {
        if (strict) {
          const message = 'NCC-02 anchoring is required, but this service has no HTTPS endpoint for a public anchor'
          this.options.store.markPublishError(id, message)
          this.changed()
          throw new HostingError('publish-failed', message)
        }
      } else {
        try {
          const anchorEvent = await this.sign(provider, anchor)
          anchorReport = await this.options.publisher.publish(anchorEvent, relays)
          if (strict && !anchorReport.ok) {
            const message = `NCC-02 anchor was rejected: ${reportError(anchorReport)}`
            this.options.store.markPublishError(id, message)
            this.changed()
            throw new HostingError('publish-failed', message)
          }
        } catch (error) {
          if (strict) {
            const message = `NCC-02 anchor failed: ${messageOf(error)}`
            this.options.store.markPublishError(id, message)
            this.changed()
            throw error instanceof HostingError ? error : new HostingError('publish-failed', message)
          }
        }
      }
    }

    const report = await this.options.publisher.publish(event, relays)
    if (anchorReport && !anchorReport.ok) {
      report.errors.push({ relay: 'anchor', error: reportError(anchorReport) })
    }
    if (!report.ok) {
      const message = reportError(report)
      this.options.store.markPublishError(id, message)
      this.changed()
      throw new HostingError('publish-failed', message)
    }
    this.options.store.markPublished(id, createdAt)

    const shares: Array<{ shareId: string; report: PublishReport }> = []
    if (service.visibility === 'private') {
      for (const share of this.options.store.sharesFor(id)) {
        if (shareStatus(share, now) !== 'active') continue
        try {
          shares.push({
            shareId: share.id,
            report: await this.publishShare(service, share, provider, hex, createdAt)
          })
        } catch (error) {
          shares.push({
            shareId: share.id,
            report: {
              ok: false,
              accepted: 0,
              relays: relays.length,
              errors: [{ relay: 'signer', error: messageOf(error) }]
            }
          })
        }
      }
    }

    this.changed()
    return { ...report, serviceId: id, shares }
  }

  async share(
    id: string,
    recipientInput: string,
    days = DEFAULT_SHARE_DAYS,
    label?: string
  ): Promise<HostingShareResult> {
    const service = this.options.store.find(id)
    if (!service) throw new HostingError('not-found', 'That service no longer exists')
    if (service.visibility === 'public') {
      throw new HostingError(
        'public-service',
        'This service is public; anyone with the address can already open it.'
      )
    }
    if (service.endpoints.length > 0 && service.endpoints.every(isLoopbackEndpoint)) {
      throw new HostingError(
        'loopback-share',
        'A loopback endpoint only works on this machine. Publish a LAN, public or .onion endpoint before sharing.'
      )
    }
    const recipient = parseRecipient(recipientInput)
    if (!recipient) {
      throw new HostingError('invalid-recipient', 'Enter the recipient’s npub or 64-character public key')
    }

    const { provider, hex, npub } = await this.requireIdentity()
    this.assertOwner(service, hex)
    if (!service.owner) this.options.store.setOwner(id, hex)
    const now = this.now()
    const safeDays = Math.min(MAX_SHARE_DAYS, Math.max(MIN_SHARE_DAYS, Math.round(Number(days) || DEFAULT_SHARE_DAYS)))
    const expiresAt = shareExpiry(safeDays, now)
    const dTag = shareDTag(service.service, recipient)
    const existing = this.options.store.findShareFor(id, recipient)
    const share: ServiceShare = {
      id: existing?.id ?? randomBytes(8).toString('hex'),
      serviceId: id,
      dTag,
      recipient,
      recipientNpub: recipientNpub(recipient),
      ...(label?.trim() ? { label: label.trim().slice(0, 80) } : {}),
      expiresAt,
      createdAt: existing?.createdAt ?? now,
      ...(existing?.lastPublishedAt ? { lastPublishedAt: existing.lastPublishedAt } : {}),
      status: 'active'
    }

    const report = await this.publishShare(service, share, provider, hex, now)
    if (!report.ok) throw new HostingError('publish-failed', reportError(report))

    this.options.store.putShare(share)
    this.changed()
    return {
      share: this.options.store.findShare(share.id) ?? share,
      address: serviceAddress(npub, dTag),
      report
    }
  }

  /**
   * Share with several recipients in one action. Each recipient gets their own
   * NIP-44 locator and no-`u` NCC-02 anchor, because NIP-44 has one conversation key
   * per recipient and the anchor is keyed by the requested `d` tag. A failure for one
   * recipient does not stop the others.
   */
  async shareMany(
    id: string,
    recipientInputs: string[],
    days = DEFAULT_SHARE_DAYS,
    label?: string
  ): Promise<HostingShareBatchResult> {
    const unique: string[] = []
    for (const input of recipientInputs) {
      const recipient = parseRecipient(input)
      if (recipient && !unique.includes(recipient)) unique.push(recipient)
    }
    if (unique.length === 0) {
      throw new HostingError('invalid-recipient', 'Choose at least one recipient')
    }
    const shares: HostingShareBatchResult['shares'] = []
    const failures: HostingShareBatchResult['failures'] = []
    for (const recipient of unique.slice(0, 100)) {
      try {
        const result = await this.share(id, recipient, days, label)
        shares.push({ ...result, recipient })
      } catch (error) {
        failures.push({ recipient, error: messageOf(error) })
      }
    }
    return { shares, failures }
  }

  async revokeShare(shareId: string): Promise<HostingShareResult> {
    const share = this.options.store.findShare(shareId)
    if (!share) throw new HostingError('not-found', 'That share no longer exists')
    const service = this.options.store.find(share.serviceId)
    if (!service) throw new HostingError('not-found', 'That service no longer exists')
    const { provider, hex, npub } = await this.requireIdentity()
    this.assertOwner(service, hex)
    const now = this.now()
    const createdAt = Math.max(now, (share.lastPublishedAt ?? share.createdAt) + 1)
    const event = await this.sign(provider, buildTombstoneTemplate(share.dTag, createdAt, now - 1))
    const report = await this.options.publisher.publish(event, await this.relays(hex))
    if (!report.ok) throw new HostingError('publish-failed', reportError(report))
    this.options.store.markShareRevoked(shareId, createdAt)
    this.changed()
    return {
      share: this.options.store.findShare(shareId) ?? { ...share, status: 'revoked' },
      address: serviceAddress(npub, share.dTag),
      report
    }
  }

  /**
   * Renew locators that are halfway through their lifetime. Only a local identity is
   * renewed automatically; a remote signer would otherwise prompt every few hours.
   */
  async renewDue(): Promise<HostingPublishResult[]> {
    const status = this.options.identity.status()
    if (!status.configured || status.mode !== 'local') return []
    const now = this.now()
    const results: HostingPublishResult[] = []
    for (const service of this.options.store.state().services) {
      if (!service.lastPublishedAt) continue
      if (now < service.lastPublishedAt + Math.floor(service.ttlSeconds / 2)) continue
      try {
        results.push(await this.publish(service.id))
      } catch {
        // The error is recorded on the service; a failed renewal must not stop others.
      }
    }
    return results
  }

  /**
   * Remember a share this identity successfully decrypted. The caller only passes
   * records that resolved with an encrypted payload, and the owner is skipped.
   */
  recordReceived(input: {
    owner: string
    dTag: string
    expiresAt: number
    title?: string
    encrypted: boolean
  }): ReceivedShare | null {
    if (!input.encrypted) return null
    const status = this.options.identity.status()
    const own = status.hexPubkey?.toLowerCase()
    if (own && own === input.owner.toLowerCase()) return null
    const existing = this.options.store
      .state()
      .received.find((entry) => entry.owner === input.owner.toLowerCase() && entry.dTag === input.dTag)
    if (existing && existing.expiresAt === input.expiresAt && existing.title === input.title) {
      return existing
    }
    const record = this.options.store.recordReceived({
      owner: input.owner,
      ownerNpub: safeNpub(input.owner),
      dTag: input.dTag,
      expiresAt: input.expiresAt,
      ...(input.title ? { title: input.title } : {})
    })
    this.changed()
    return record
  }

  forgetReceived(id: string): void {
    this.options.store.forgetReceived(id)
    this.changed()
  }

  private async publishShare(
    service: HostedService,
    share: ServiceShare,
    provider: HostingProvider,
    ownerHex: string,
    now: number
  ): Promise<PublishReport> {
    const endpoints = service.endpoints.filter((endpoint) => !isLoopbackEndpoint(endpoint))
    if (endpoints.length === 0) {
      throw new HostingError(
        'loopback-share',
        'A loopback endpoint only works on this machine. Publish a LAN, public or .onion endpoint before sharing.'
      )
    }
    const createdAt = Math.max(now, (share.lastPublishedAt ?? share.createdAt) + 1)
    const payload = sharePayload({ ...service, endpoints }, share.expiresAt, createdAt)
    const json = locatorContent(payload)
    const content = await provider.nip44Encrypt(share.recipient, json)
    const event = await this.sign(
      provider,
      buildLocatorTemplate({
        dTag: share.dTag,
        ttlSeconds: payload.ttl,
        content,
        now: createdAt,
        privateTag: true,
        expiresAt: share.expiresAt
      })
    )
    const relays = await this.relays(ownerHex)
    const strict = this.options.anchorRequired?.() === true
    // Anchored mode looks up the anchor by the requested `d` tag, and a share has its
    // own. Publish a no-`u` NCC-02 anchor under that tag first: if it fails in strict
    // mode the locator is not published, so a strict recipient never sees a share it
    // cannot accept.
    const anchor = buildAnchorTemplate({
      service: share.dTag,
      endpoint: endpoints.find((endpoint) => endpoint.url.startsWith('https://')),
      days: Math.max(1, Math.ceil((share.expiresAt - createdAt) / 86_400)),
      now: createdAt,
      privateMode: true
    })
    let anchorReport: PublishReport | null = null
    if (anchor) {
      try {
        const anchorEvent = await this.sign(provider, anchor)
        anchorReport = await this.options.publisher.publish(anchorEvent, relays)
        if (strict && !anchorReport.ok) {
          throw new HostingError(
            'publish-failed',
            `NCC-02 anchor was rejected: ${reportError(anchorReport)}`
          )
        }
      } catch (error) {
        if (strict) {
          throw error instanceof HostingError
            ? error
            : new HostingError('publish-failed', `NCC-02 anchor failed: ${messageOf(error)}`)
        }
      }
    } else if (strict) {
      throw new HostingError('publish-failed', 'NCC-02 anchoring is required, but no anchor could be built')
    }

    const report = await this.options.publisher.publish(event, relays)
    if (anchorReport && !anchorReport.ok) {
      report.errors.push({ relay: 'anchor', error: reportError(anchorReport) })
    }
    if (report.ok) {
      share.lastPublishedAt = createdAt
      this.options.store.markSharePublished(share.id, createdAt)
    }
    return report
  }

  private async requireIdentity(): Promise<{
    provider: HostingProvider
    hex: string
    npub: string
  }> {
    const provider = this.options.identity.provider()
    if (!provider) {
      throw new HostingError('identity-required', 'Connect a Nostr identity to publish a service')
    }
    const hex = (await provider.getPublicKey()).toLowerCase()
    return { provider, hex, npub: nip19.npubEncode(hex) }
  }

  private assertOwner(service: HostedService, hex: string): void {
    if (service.owner && service.owner !== hex) {
      throw new HostingError(
        'wrong-identity',
        'This service was published as a different identity. Switch to that identity or create a new service.'
      )
    }
  }

  private async sign(provider: HostingProvider, template: EventTemplate): Promise<Event> {
    let event: Event
    try {
      event = await provider.signEvent(template)
    } catch (error) {
      throw new HostingError('signer-failed', messageOf(error))
    }
    if (!verifyEvent(event)) {
      throw new HostingError('signer-failed', 'The signer returned an invalid signature')
    }
    return event
  }

  private async relays(ownerHex: string): Promise<string[]> {
    const relays = await this.options.publisher.relaysFor(ownerHex)
    if (relays.length === 0) {
      throw new HostingError('publish-failed', 'No relays are configured')
    }
    return relays
  }

  private changed(): void {
    this.options.onChange?.(this.state())
  }
}

function reportError(report: PublishReport): string {
  if (report.errors.length === 0) return `No relay accepted the record (${report.relays} tried)`
  return `No relay accepted the record: ${report.errors.map((error) => `${error.relay}: ${error.error}`).join('; ')}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex)
  } catch {
    return ''
  }
}
