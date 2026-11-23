import type { WebContents } from 'electron'
import type { BrowserShell } from '../shell'

const shellsByChrome = new Map<number, BrowserShell>()

export function registerShell(chromeWebContentsId: number, shell: BrowserShell): void {
  shellsByChrome.set(chromeWebContentsId, shell)
}

export function unregisterShell(chromeWebContentsId: number): void {
  shellsByChrome.delete(chromeWebContentsId)
}

export function browserShellFor(contents: WebContents): BrowserShell | null {
  return shellsByChrome.get(contents.id) ?? null
}

/** Resolve a page WebContents to the browser window currently owning its tab. */
export function browserShellForTabContents(contents: WebContents): BrowserShell | null {
  for (const shell of shellsByChrome.values()) {
    if (shell.tabIdForContents(contents.id) !== null) return shell
  }
  return null
}

export function browserShells(): BrowserShell[] {
  return [...shellsByChrome.values()]
}
