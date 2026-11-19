import { dialog, systemPreferences, type BrowserWindow } from 'electron'
import type { PaymentCardAuth, PaymentCardAuthContext } from './service'

/** Electron exposes biometric reauthentication on macOS; other desktop platforms opt into signer approval. */
export function createPaymentCardAuth(parent: BrowserWindow): PaymentCardAuth {
  const available = (): boolean => process.platform === 'darwin' && systemPreferences.canPromptTouchID()
  return {
    available,
    async authenticate(): Promise<void> {
      if (!available()) throw new Error('Device authentication is unavailable')
      await systemPreferences.promptTouchID('Confirm your identity to fill payment card details')
    },
    async chooseMethod(context: PaymentCardAuthContext, systemAvailable: boolean, nostrAvailable: boolean) {
      const buttons = [
        ...(systemAvailable ? ['Use system authentication'] : []),
        ...(nostrAvailable ? ['Use Nostr signer'] : []),
        ...(nostrAvailable ? ['Use Nostr signer and make default'] : []),
        'Cancel'
      ]
      if (!systemAvailable && !nostrAvailable) throw new Error('No card confirmation method is available. Connect a Nostr signer or use a device with system authentication.')
      const nostrIndex = buttons.indexOf('Use Nostr signer')
      const nostrDefaultIndex = buttons.indexOf('Use Nostr signer and make default')
      const cancelId = buttons.indexOf('Cancel')
      const result = await dialog.showMessageBox(parent, {
        type: 'question',
        title: 'Confirm card fill',
        message: `Choose how to confirm ${context.network} ending in ${context.last4}`,
        detail: `This card will be filled on ${context.origin}. Nostr signer approval is required for every fill.`,
        buttons,
        defaultId: systemAvailable ? 0 : nostrIndex,
        cancelId,
        noLink: true
      })
      if (result.response === cancelId) return null
      const method = result.response === nostrIndex || result.response === nostrDefaultIndex ? 'nostr' : 'system'
      return { method, makeDefault: method === 'nostr' && result.response === nostrDefaultIndex }
    }
  }
}
