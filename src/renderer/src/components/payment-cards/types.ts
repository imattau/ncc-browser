import type { PaymentCardDraft } from '@shared/payment-cards'

export const EMPTY_CARD: PaymentCardDraft = {
  name: '',
  number: '',
  expMonth: '',
  expYear: '',
  nickname: ''
}

export interface PaymentCardConfigPatch {
  fillPaymentCards?: boolean
  offerPaymentCardSave?: boolean
  savePaymentCardSecurityCodes?: boolean
  allowNostrPaymentCardAuth?: boolean
  defaultNostrPaymentCardAuth?: boolean
}
