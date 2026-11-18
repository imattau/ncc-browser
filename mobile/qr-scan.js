import jsQR from 'jsqr'

/** Pull the payment address (and optional amount) out of a scanned QR payload. */
export function parsePaymentQr(text, scheme) {
  let value = String(text).trim()
  const prefix = new RegExp(`^${scheme}:`, 'i')
  let amount = ''
  if (prefix.test(value)) {
    value = value.replace(prefix, '')
    const [address, query = ''] = value.split('?')
    value = address
    const params = new URLSearchParams(query)
    amount = params.get('amount') || params.get('tx_amount') || ''
  }
  return { address: value.trim(), amount: /^\d*\.?\d+$/.test(amount) ? amount : '' }
}

/** Open the camera in a full-screen overlay; resolves with the first QR text, or null if cancelled. */
export function scanQr() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'qr-scan'
    overlay.innerHTML = '<video playsinline muted></video><p class="qr-scan-hint" role="status">Point the camera at a QR code</p><button type="button" class="btn tonal qr-scan-cancel">Cancel</button>'
    const video = overlay.querySelector('video')
    const hint = overlay.querySelector('.qr-scan-hint')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null
    let stream = null
    let done = false
    let frame = 0

    const finish = (result) => {
      if (done) return
      done = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      overlay.remove()
      resolve(result)
    }
    overlay.querySelector('.qr-scan-cancel').addEventListener('click', () => finish(null))

    const tick = async () => {
      if (done) return
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          if (detector) {
            const [code] = await detector.detect(video)
            if (code?.rawValue) return finish(code.rawValue)
          } else {
            const scale = Math.min(1, 640 / video.videoWidth)
            canvas.width = Math.round(video.videoWidth * scale)
            canvas.height = Math.round(video.videoHeight * scale)
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            const image = context.getImageData(0, 0, canvas.width, canvas.height)
            const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
            if (code?.data) return finish(code.data)
          }
        } catch { /* keep scanning */ }
      }
      frame = requestAnimationFrame(tick)
    }

    document.body.append(overlay)
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((media) => {
        if (done) { media.getTracks().forEach((track) => track.stop()); return }
        stream = media
        video.srcObject = media
        return video.play().then(tick)
      })
      .catch(() => { hint.textContent = 'Camera unavailable. Allow camera access for NCC Browser and try again.' })
  })
}
