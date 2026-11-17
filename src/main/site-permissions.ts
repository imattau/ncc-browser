import { dialog, type BrowserWindow, type Session } from 'electron'

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
