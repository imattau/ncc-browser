import { app } from 'electron'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HomeSite } from '@shared/home-sites'

function safeName(title: string): string {
  return title.normalize('NFKD').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 70) || 'Website'
}

function desktopQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`
}

/** Create a URL launcher on the current user's desktop. */
export function createHomeShortcut(site: HomeSite): void {
  const desktop = app.getPath('desktop')
  const suffix = createHash('sha256').update(site.url).digest('hex').slice(0, 10)
  const name = `${safeName(site.title)}-${suffix}`
  if (process.platform === 'win32') {
    writeFileSync(join(desktop, `${name}.url`), `[InternetShortcut]\r\nURL=${site.url}\r\n`, { mode: 0o600 })
    return
  }
  if (process.platform === 'darwin') {
    const escaped = site.url.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    writeFileSync(join(desktop, `${name}.webloc`), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${escaped}</string></dict></plist>\n`, { mode: 0o600 })
    return
  }
  const desktopFile = `[Desktop Entry]\nType=Application\nName=${site.title.replace(/[\r\n]/g, ' ')}\nComment=Open ${site.url}\nExec=xdg-open ${desktopQuote(site.url)}\nTerminal=false\nCategories=Network;WebBrowser;\nURL=${site.url}\n`
  writeFileSync(join(desktop, `${name}.desktop`), desktopFile, { mode: 0o700 })
}
