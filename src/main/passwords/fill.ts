import { randomUUID } from 'node:crypto'
import {
  canUsePasswordOrigin,
  findEntry,
  pageOriginFromUrl,
  type PasswordFillResult,
  type PasswordVault
} from '@shared/passwords'
import type { PasswordHost } from './service'

interface FillWaiter {
  resolve: (result: PasswordFillResult) => void
  timer: NodeJS.Timeout
}

export interface FillContext {
  unlocked: () => boolean
  vault: () => PasswordVault | null
  host: PasswordHost
  touch: () => void
  sendContext: () => void
}

const LOCKED = 'Unlock the password manager first'

/**
 * Fill requests wait for a page acknowledgement; form detection is the other half of
 * the same per-tab conversation. Both are kept here so the vault service only exposes
 * one method pair.
 */
export class PasswordFill {
  private readonly waiters = new Map<string, FillWaiter>()
  private readonly formState = new Map<string, { hasLoginForm: boolean; title: string }>()

  constructor(private readonly ctx: FillContext) {}

  formFor(tabId: string): { hasLoginForm: boolean; title: string } | undefined {
    return this.formState.get(tabId)
  }

  async fill(id: string): Promise<PasswordFillResult> {
    const vault = this.ctx.vault()
    if (!this.ctx.unlocked() || !vault) return { ok: false, error: LOCKED }
    const page = this.ctx.host.activePage()
    if (!page) return { ok: false, error: 'There is no active page' }
    if (page.kind === 'private') {
      return { ok: false, error: 'Passwords are unavailable in private tabs' }
    }
    const info = pageOriginFromUrl(page.url)
    if (!info || !canUsePasswordOrigin(info)) {
      return { ok: false, error: 'Passwords are disabled on this page' }
    }
    const entry = findEntry(vault, id)
    if (!entry || entry.deleted) return { ok: false, error: 'That login no longer exists' }
    if (entry.origin !== info.origin) {
      return { ok: false, error: 'That login belongs to a different site' }
    }

    const requestId = randomUUID()
    const result = new Promise<PasswordFillResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        resolve({ ok: false, error: 'The page did not accept the login' })
      }, 5_000)
      timer.unref?.()
      this.waiters.set(requestId, { resolve, timer })
    })

    const sent = this.ctx.host.sendToContent(page.tabId, 'passwords:fill', {
      requestId,
      username: entry.username,
      password: entry.password,
      // The page checks it is still the one the login was matched to.
      pageUrl: page.url
    })
    if (!sent) {
      const waiter = this.waiters.get(requestId)
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: false, error: 'The page is no longer available' })
        this.waiters.delete(requestId)
      }
    }
    this.ctx.touch()
    return result
  }

  handleResult(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const value = payload as { requestId?: unknown; ok?: unknown; error?: unknown; usernameOnly?: unknown }
    if (typeof value.requestId !== 'string') return
    const waiter = this.waiters.get(value.requestId)
    if (!waiter) return
    this.waiters.delete(value.requestId)
    clearTimeout(waiter.timer)
    waiter.resolve({
      ok: value.ok === true,
      ...(value.usernameOnly === true ? { usernameOnly: true } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {})
    })
  }

  handleFormState(webContentsId: number, payload: unknown): void {
    const tabId = this.ctx.host.tabIdForContents(webContentsId)
    if (!tabId) return
    const page = this.ctx.host.pageForTab(tabId)
    if (!page || page.kind === 'private') return
    const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    this.formState.set(tabId, {
      hasLoginForm: value.hasLoginForm === true,
      title: typeof value.title === 'string' ? value.title.slice(0, 200) : ''
    })
    if (this.ctx.host.activePage()?.tabId === tabId) this.ctx.sendContext()
  }

  /** Resolve every pending fill, e.g. when the vault locks or the service disposes. */
  release(message: string): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, error: message })
    }
    this.waiters.clear()
  }

  /** Resolve pending fills when the vault locks. Form state survives the lock. */
  clear(): void {
    this.release('The password manager locked')
  }

  dispose(): void {
    for (const waiter of this.waiters.values()) clearTimeout(waiter.timer)
    this.waiters.clear()
  }
}
