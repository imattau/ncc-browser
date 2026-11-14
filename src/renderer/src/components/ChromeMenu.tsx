import { useEffect } from 'react'
import { Smartphone } from 'lucide-react'
import { COMMANDS, COMMAND_ORDER, type CommandId } from '@shared/commands'
import type { IdentityStatus, NavState } from '@shared/types'
import { cn } from '../lib/cn'

interface ChromeMenuProps {
  state: NavState
  identity: IdentityStatus | null
  onCommand: (command: CommandId) => void
  onClose: () => void
}

export function ChromeMenu({ state, identity, onCommand, onClose }: ChromeMenuProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const isMac = navigator.platform.toLowerCase().includes('mac')

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/45 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="menu"
        data-chrome-menu
        className="ncc-fade-in absolute right-3 top-[104px] max-h-[72vh] w-[312px] overflow-y-auto rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] py-1.5 shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[color:var(--color-line)] px-3 pb-2.5 pt-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
              NCC Browser
            </span>
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-[10px]',
                identity?.mode === 'nip46'
                  ? 'border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
              )}
            >
              {identity?.mode === 'nip46'
                ? 'remote signer'
                : identity?.configured
                  ? 'local key'
                  : 'no identity'}
            </span>
          </div>
          {identity?.npub ? (
            <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-[10px] text-[#5d6575]">
              {identity.mode === 'nip46' ? <Smartphone className="h-3 w-3 shrink-0" /> : null}
              {identity.npub.slice(0, 18)}…{identity.npub.slice(-6)}
            </p>
          ) : null}
        </div>

        {COMMAND_ORDER.map((group) => {
          const items = COMMANDS.filter((command) => command.group === group)
          if (items.length === 0) return null

          return (
            <div key={group} className="px-1.5 pt-1.5">
              <p className="px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[#5d6575]">
                {group}
              </p>
              {items.map((command) => {
                const enabled = isEnabled(command.id, state)
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="menuitem"
                    data-command={command.id}
                    disabled={!enabled}
                    onClick={() => onCommand(command.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors',
                      enabled
                        ? 'text-[#e7e9ef] hover:bg-white/[0.06]'
                        : 'cursor-default text-[#4d5462]'
                    )}
                  >
                    <span className="truncate">{command.label}</span>
                    {command.shortcut ? (
                      <span className="shrink-0 font-mono text-[10px] text-[#6d7585]">
                        {isMac
                          ? command.shortcut.replace('Ctrl', '⌘').replace('Alt', '⌥')
                          : command.shortcut}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function isEnabled(id: CommandId, state: NavState): boolean {
  switch (id) {
    case 'close-tab':
    case 'reload':
    case 'force-reload':
    case 'toggle-page-devtools':
      return state.tabs.length > 0
    case 'next-tab':
    case 'previous-tab':
      return state.tabs.length > 1
    case 'back':
      return state.canGoBack
    case 'forward':
      return state.canGoForward
    case 'stop':
      return state.loading
    default:
      return true
  }
}
