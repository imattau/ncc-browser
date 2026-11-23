import type { PaymentCardSettingsStatus } from '@shared/payment-cards'
import type { PaymentCardConfigPatch } from './types'

interface PaymentCardPreferencesProps {
  status: PaymentCardSettingsStatus
  onConfig: (patch: PaymentCardConfigPatch) => void
}

/** Autofill, save and authentication switches for payment cards. */
export function PaymentCardPreferences({ status, onConfig }: PaymentCardPreferencesProps) {
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-ui-11 text-[color:var(--color-text)]">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={status.enabled}
            onChange={(event) => onConfig({ fillPaymentCards: event.target.checked })}
          />
          Offer card autofill
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={status.offerSave}
            onChange={(event) => onConfig({ offerPaymentCardSave: event.target.checked })}
          />
          Ask to save cards after checkout
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={status.saveSecurityCodes}
            onChange={(event) =>
              onConfig({ savePaymentCardSecurityCodes: event.target.checked })
            }
          />
          Ask to save and autofill security codes (CVC/CVV)
        </label>
      </div>
      {status.saveSecurityCodes ? (
        <p className="mt-2 text-ui-105 text-[color:var(--color-muted)]">
          When enabled, a checkout save prompt can include the security code. Turning this off
          removes saved codes from your encrypted card vault.
        </p>
      ) : null}

      <div className="mt-3 space-y-2 border-t border-[color:var(--color-line)] pt-3 text-ui-11 text-[color:var(--color-text)]">
        <label className="flex items-start gap-2">
          <input
            className="mt-0.5"
            type="checkbox"
            checked={status.allowNostrAuth}
            onChange={(event) => onConfig({ allowNostrPaymentCardAuth: event.target.checked })}
          />
          <span>Allow Nostr signer confirmation for card fills</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            className="mt-0.5"
            type="checkbox"
            checked={status.defaultNostrAuth}
            onChange={(event) =>
              onConfig({
                allowNostrPaymentCardAuth: event.target.checked || status.allowNostrAuth,
                defaultNostrPaymentCardAuth: event.target.checked
              })
            }
          />
          <span>
            Make Nostr signer the default confirmation method{' '}
            <span className="text-ui-105 text-[color:var(--color-muted)]">
              Selecting this also enables Nostr confirmation.
            </span>
          </span>
        </label>
        {status.allowNostrAuth ? (
          <p className="text-ui-105 text-[color:var(--color-muted)]">
            Nostr confirmation is requested for each fill. When it is not the default, choose
            between it and system authentication each time.
          </p>
        ) : null}
        {status.allowNostrAuth && !status.nostrAuthAvailable ? (
          <p className="text-ui-105 text-[color:var(--color-warn)]">
            Connect or unlock a Nostr signer before using Nostr confirmation.
          </p>
        ) : null}
        {!status.authAvailable && !status.allowNostrAuth ? (
          <p className="text-ui-105 text-[color:var(--color-warn)]">
            System authentication is unavailable on this device. Enable Nostr confirmation to
            choose it for each fill or make it the default.
          </p>
        ) : null}
      </div>
    </>
  )
}
