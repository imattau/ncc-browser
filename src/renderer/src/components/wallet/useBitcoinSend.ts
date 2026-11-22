import { useState } from 'react'
import type { BitcoinSendPreview } from '@shared/wallet'
import { messageOf } from '../../lib/format'
import { shortId, type WalletContext } from './types'

type Wallet = Pick<WalletContext, 'busy' | 'setBusy' | 'setMessage' | 'refresh'>

export interface BitcoinSendApi {
  open: boolean
  address: string
  amount: string
  preview: BitcoinSendPreview | null
  setAddress: (value: string) => void
  setAmount: (value: string) => void
  start: () => void
  close: () => void
  prepare: () => Promise<void>
  confirm: () => Promise<void>
}

/** Destination/amount entry and the two-step Bitcoin send flow. */
export function useBitcoinSend(wallet: Wallet): BitcoinSendApi {
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [preview, setPreview] = useState<BitcoinSendPreview | null>(null)

  const start = (): void => {
    setOpen(true)
    setPreview(null)
  }

  const close = (): void => {
    setOpen(false)
    setPreview(null)
  }

  async function prepare() {
    wallet.setBusy(true)
    wallet.setMessage('')
    try {
      setPreview(await window.ncc.walletPrepareBitcoinSend(address, amount))
    } catch (error) {
      wallet.setMessage(messageOf(error))
    } finally {
      wallet.setBusy(false)
    }
  }

  async function confirm() {
    if (!preview) return
    wallet.setBusy(true)
    wallet.setMessage('')
    try {
      const result = await window.ncc.walletConfirmBitcoinSend(preview.token)
      setPreview(null)
      setOpen(false)
      setAddress('')
      setAmount('')
      wallet.setMessage(`Broadcast. Transaction ${shortId(result.txid)}`)
      await wallet.refresh()
    } catch (error) {
      wallet.setMessage(messageOf(error))
    } finally {
      wallet.setBusy(false)
    }
  }

  return {
    open,
    address,
    amount,
    preview,
    setAddress,
    setAmount,
    start,
    close,
    prepare,
    confirm
  }
}
