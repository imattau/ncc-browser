import type { SignerRequest } from '@shared/types'
import type {
  PasskeyConfirmationRequest,
  PasswordSaveRequest,
  PasswordToast
} from '@shared/passwords'
import type { PaymentCardSaveRequest } from '@shared/payment-cards'
import { PasskeyConfirmationPrompt } from '../PasskeyConfirmationPrompt'
import { PasswordSavePrompt } from '../PasswordSavePrompt'
import { PaymentCardSavePrompt } from '../PaymentCardSavePrompt'
import { SignerPrompt } from '../SignerPrompt'
import { cn } from '../../lib/cn'

interface AppPromptsProps {
  signerRequest: SignerRequest | null
  signerWaiting: number
  onRespondToSigner: (allow: boolean, remember: boolean) => void
  passwordSave: PasswordSaveRequest | null
  passwordSaveBusy: boolean
  passwordSaveError: string | null
  onRespondToPasswordSave: (action: 'save' | 'never' | 'dismiss') => void
  paymentCardSave: PaymentCardSaveRequest | null
  paymentCardSaveBusy: boolean
  paymentCardSaveError: string | null
  onRespondToPaymentCardSave: (action: 'save' | 'dismiss') => void
  passkeyConfirmation: PasskeyConfirmationRequest | null
  onRespondToPasskeyConfirmation: (choice: number | null) => void
  passwordToast: PasswordToast | null
}

/** Approval sheets and the transient password toast. */
export function AppPrompts({
  signerRequest,
  signerWaiting,
  onRespondToSigner,
  passwordSave,
  passwordSaveBusy,
  passwordSaveError,
  onRespondToPasswordSave,
  paymentCardSave,
  paymentCardSaveBusy,
  paymentCardSaveError,
  onRespondToPaymentCardSave,
  passkeyConfirmation,
  onRespondToPasskeyConfirmation,
  passwordToast
}: AppPromptsProps) {
  return (
    <>
      {signerRequest ? (
        <SignerPrompt
          request={signerRequest}
          onRespond={onRespondToSigner}
          waiting={signerWaiting}
        />
      ) : null}

      {passwordSave ? (
        <PasswordSavePrompt
          request={passwordSave}
          busy={passwordSaveBusy}
          error={passwordSaveError}
          onRespond={onRespondToPasswordSave}
        />
      ) : null}

      {paymentCardSave ? (
        <PaymentCardSavePrompt
          request={paymentCardSave}
          busy={paymentCardSaveBusy}
          error={paymentCardSaveError}
          onRespond={onRespondToPaymentCardSave}
        />
      ) : null}

      {passkeyConfirmation ? (
        <PasskeyConfirmationPrompt
          request={passkeyConfirmation}
          onRespond={onRespondToPasskeyConfirmation}
        />
      ) : null}

      {passwordToast ? (
        <div
          className={cn(
            'fixed bottom-3 right-3 z-[110] max-w-sm rounded-xl border px-3 py-2 text-ui-11 shadow-lg',
            passwordToast.tone === 'error'
              ? 'border-[color:var(--color-danger)]/35 bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
              : passwordToast.tone === 'warn'
                ? 'border-[color:var(--color-warn)]/35 bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn)]'
                : 'border-[color:var(--color-ok)]/35 bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
          )}
          role="status"
        >
          {passwordToast.message}
        </div>
      ) : null}
    </>
  )
}
