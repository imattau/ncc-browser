import { dialog, type BrowserWindow, type Session, type WebContents } from 'electron'

/** Camera access is limited to the browser's trusted shell renderer for QR scanning. */
export function installShellCameraPermission(session: Session, getShellContents: () => WebContents, rendererUrl?: string): void {
  const shellOrigin = (value: string): string | null => {
    try {
      const url = new URL(value)
      return url.protocol === 'file:' ? 'file://' : url.origin
    } catch { return null }
  }
  const trustedOrigins = new Set(['file://'])
  if (rendererUrl) {
    const origin = shellOrigin(rendererUrl)
    if (origin) trustedOrigins.add(origin)
  }
  const isTrustedShell = (contents: WebContents | null, url: string): boolean => {
    if (!contents || contents.isDestroyed()) return false
    const shellContents = getShellContents()
    return !shellContents.isDestroyed() && contents.id === shellContents.id && trustedOrigins.has(shellOrigin(url) ?? '')
  }

  session.setPermissionCheckHandler((contents, permission, origin) =>
    permission === 'media' && isTrustedShell(contents, origin)
  )
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || contents.getURL()
    const hasVideoRequest = 'mediaTypes' in details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video')
    callback(permission === 'media' && hasVideoRequest && isTrustedShell(contents, requestingUrl))
  })
}

/** Permission decisions are per-origin and per-session; private/Tor grants vanish with the session. */
export function installSitePermissionPrompts(sessions: Session[], getWindow: () => BrowserWindow): void {
  for (const session of sessions) {
    const decisions = new Map<string, boolean>()
    session.setPermissionCheckHandler((_contents, permission, origin) =>
      decisions.get(`${origin}|${permission}`) === true
    )
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const raw = details.requestingUrl || contents.getURL()
      let origin = ''
      try { origin = new URL(raw).origin } catch { callback(false); return }
      const key = `${origin}|${permission}`
      const remembered = decisions.get(key)
      if (remembered !== undefined) { callback(remembered); return }
      void dialog.showMessageBox(getWindow(), {
        type: 'question',
        buttons: ['Allow for this session', 'Block'],
        defaultId: 1,
        cancelId: 1,
        title: 'Site permission',
        message: `${origin} wants to use ${permission.replaceAll('-', ' ')}.`,
        detail: 'This decision is remembered for this browser session.'
      }).then(({ response }) => {
        const allowed = response === 0
        decisions.set(key, allowed)
        callback(allowed)
      }).catch(() => callback(false))
    })
  }
}
