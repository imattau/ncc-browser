import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

/**
 * Camera preview and QR decoding for Lightning invoices. The caller decides what a
 * decoded invoice does; the scan loop itself is local to this hook so the dialog stays
 * presentational.
 */
export function useLightningScanner(open: boolean, onInvoice: (invoice: string) => void) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [scannerError, setScannerError] = useState('')
  const onInvoiceRef = useRef(onInvoice)
  onInvoiceRef.current = onInvoice

  useEffect(() => {
    if (!open) return
    let active = true
    let stream: MediaStream | null = null
    let animationFrame = 0
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    setScannerError('')
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access is unavailable in this app.')
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        })
        if (!active) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        const video = videoRef.current
        if (!video) throw new Error('Camera preview could not be opened.')
        video.srcObject = stream
        await video.play()
        const scan = () => {
          if (!active || !video.videoWidth || !video.videoHeight || !context) {
            animationFrame = requestAnimationFrame(scan)
            return
          }
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
          const result = jsQR(pixels.data, pixels.width, pixels.height, {
            inversionAttempts: 'attemptBoth'
          })
          if (result?.data) {
            const invoice = result.data.trim().replace(/^lightning:/i, '')
            if (/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) {
              onInvoiceRef.current(invoice)
              return
            }
            setScannerError('That QR code does not contain a Lightning invoice.')
          }
          animationFrame = requestAnimationFrame(scan)
        }
        animationFrame = requestAnimationFrame(scan)
      } catch (error) {
        setScannerError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      active = false
      cancelAnimationFrame(animationFrame)
      stream?.getTracks().forEach((track) => track.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [open])

  return { videoRef, scannerError }
}
