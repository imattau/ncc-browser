import { useState } from 'react'
import { messageOf } from '../../lib/format'
import { decodeBolt11Invoice } from '@shared/bolt11'
import type { WalletContext } from './types'

type Wallet = Pick<WalletContext, 'nwc' | 'setNwc' | 'setBusy' | 'setMessage'>

export interface LightningWalletApi {
  uri: string
  setUri: (value: string) => void
  invoice: string
  setInvoice: (value: string) => void
  amount: string
  setAmount: (value: string) => void
  receiveInvoice: string
  sendOpen: boolean
  receiveOpen: boolean
  payReview: boolean
  setPayReview: (value: boolean) => void
  scannerOpen: boolean
  startSend: () => void
  closeSend: () => void
  startReceive: () => void
  closeReceive: () => void
  openScanner: () => void
  closeScanner: () => void
  handleScanned: (invoice: string) => void
  connect: () => Promise<void>
  disconnect: () => void
  pay: () => Promise<void>
  createInvoice: () => Promise<void>
}

/** NWC connection, invoice creation and the Lightning dialogs. */
export function useLightningWallet(wallet: Wallet): LightningWalletApi {
  const [uri, setUri] = useState('')
  const [invoice, setInvoice] = useState('')
  const [amount, setAmount] = useState('')
  const [receiveInvoice, setReceiveInvoice] = useState('')
  const [sendOpen, setSendOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [payReview, setPayReview] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)

  const startSend = (): void => {
    setSendOpen(true)
    setPayReview(false)
  }

  const closeSend = (): void => {
    setSendOpen(false)
    setPayReview(false)
  }

  const handleScanned = (scanned: string): void => {
    setInvoice(scanned)
    setPayReview(false)
    setScannerOpen(false)
    wallet.setMessage('Lightning invoice scanned.')
  }

  async function connect() {
    wallet.setBusy(true)
    wallet.setMessage('')
    try {
      wallet.setNwc(await window.ncc.nwcConnect(uri))
      setUri('')
      wallet.setMessage('Lightning wallet connected.')
    } catch (error) {
      wallet.setMessage(messageOf(error))
    } finally {
      wallet.setBusy(false)
    }
  }

  function disconnect(): void {
    void window.ncc.nwcDisconnect().then(wallet.setNwc)
  }

  async function pay() {
    if (!invoice.trim()) return
    wallet.setBusy(true)
    wallet.setMessage('')
    try {
      const decoded = decodeBolt11Invoice(invoice)
      if (decoded.expired) throw new Error('This Lightning invoice has expired. Request a new invoice.')
      await window.ncc.nwcPay(decoded.invoice)
      setInvoice('')
      setPayReview(false)
      setSendOpen(false)
      wallet.setMessage('Lightning payment sent.')
    } catch (error) {
      wallet.setMessage(messageOf(error))
    } finally {
      wallet.setBusy(false)
    }
  }

  async function createInvoice() {
    const sats = Number(amount)
    if (!Number.isSafeInteger(sats) || sats <= 0 || sats > Number.MAX_SAFE_INTEGER / 1000) {
      wallet.setMessage('Enter a valid amount in sats.')
      return
    }
    wallet.setBusy(true)
    wallet.setMessage('')
    try {
      const result = await window.ncc.nwcMakeInvoice({ amount: sats * 1000 })
      setReceiveInvoice(result.invoice)
      setReceiveOpen(false)
      wallet.setMessage('Lightning invoice created.')
    } catch (error) {
      wallet.setMessage(messageOf(error))
    } finally {
      wallet.setBusy(false)
    }
  }

  return {
    uri,
    setUri,
    invoice,
    setInvoice,
    amount,
    setAmount,
    receiveInvoice,
    sendOpen,
    receiveOpen,
    payReview,
    setPayReview,
    scannerOpen,
    startSend,
    closeSend,
    startReceive: () => setReceiveOpen(true),
    closeReceive: () => setReceiveOpen(false),
    openScanner: () => setScannerOpen(true),
    closeScanner: () => setScannerOpen(false),
    handleScanned,
    connect,
    disconnect,
    pay,
    createInvoice
  }
}
