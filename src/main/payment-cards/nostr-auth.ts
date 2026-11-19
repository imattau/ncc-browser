import { randomBytes } from 'node:crypto'
import { verifyEvent } from 'nostr-tools'
import type { ApprovalBroker } from '../approval'
import type { IdentityManager } from '../signer/manager'
import type { PaymentCardAuthContext, PaymentCardNostrAuth } from './service'

const CHALLENGE_KIND = 27235

/** One-shot user approval followed by a challenge signed by the active Nostr identity. */
export class NostrPaymentCardAuth implements PaymentCardNostrAuth {
  constructor(
    private readonly identity: IdentityManager,
    private readonly approvals: Pick<ApprovalBroker, 'request'>
  ) {}

  available(): boolean {
    return this.identity.provider() !== null
  }

  async authenticate(context: PaymentCardAuthContext): Promise<void> {
    const provider = this.identity.provider()
    if (!provider) throw new Error('Connect or unlock a Nostr signer to confirm this card fill.')
    const status = provider.status()
    const pubkey = await provider.getPublicKey()
    const decision = await this.approvals.request({
      method: 'payment-card-auth',
      kind: 'payment-card-auth',
      action: `confirm filling ${context.network} ending in ${context.last4}`,
      service: context.origin,
      origin: context.origin,
      identity: status.npub ?? null,
      mode: status.mode,
      note: `The card will be filled on ${context.origin}. A one-time Nostr challenge is signed locally or by your connected remote signer.`,
      rememberable: false
    })
    if (!decision.allow) throw new Error('Nostr signer confirmation was cancelled.')

    const challenge = randomBytes(32).toString('hex')
    const event = await provider.signEvent({
      kind: CHALLENGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['challenge', challenge]],
      content: JSON.stringify({ purpose: 'ncc-payment-card-fill', origin: context.origin, network: context.network, last4: context.last4 })
    })
    if (!verifyEvent(event) || event.pubkey !== pubkey || !event.tags.some((tag) => tag[0] === 'challenge' && tag[1] === challenge)) {
      throw new Error('The active Nostr signer did not verify the card-fill challenge.')
    }
  }
}
