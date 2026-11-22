import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bot,
  CircleHelp,
  Globe,
  KeyRound,
  Palette,
  Puzzle,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Vault
} from 'lucide-react'
import type { HostingDraft } from '@shared/hosting'
import type { IdentityStatus } from '@shared/types'
import { cn } from '../../lib/cn'
import { AgentSettings } from '../AgentSettings'
import { AppearanceSettings } from '../AppearanceSettings'
import { ExtensionSettings } from '../ExtensionSettings'
import { HostingSettings } from '../HostingSettings'
import { PasswordSettings } from '../PasswordSettings'
import { SitePublishingSettings } from '../SitePublishingSettings'
import { SyncSettings } from '../SyncSettings'
import { AboutSettings } from './AboutSettings'
import { GeneralSettings } from './GeneralSettings'
import { IdentitySettings } from './IdentitySettings'
import { SecuritySettings } from './SecuritySettings'
import { TrustedServices } from './TrustedServices'
import { useBrowserSettings } from './useBrowserSettings'
import { useIdentityAdmin } from './useIdentityAdmin'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'security'
  | 'identity'
  | 'services'
  | 'sites'
  | 'passwords'
  | 'sync'
  | 'extensions'
  | 'agent'
  | 'trusted'
  | 'about'

interface SettingsPageProps {
  open: boolean
  initialSection: SettingsSection
  onClose: () => void
  onIdentityChange?: (status: IdentityStatus) => void
  passwordDraftOrigin?: string | null
  onPasswordDraftUsed?: () => void
  hostingDraft?: HostingDraft | null
  onHostingDraftUsed?: () => void
}

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof KeyRound }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'identity', label: 'Identity & signer', icon: KeyRound },
  { id: 'services', label: 'Services', icon: Server },
  { id: 'sites', label: 'Sites', icon: Globe },
  { id: 'passwords', label: 'Passwords', icon: Vault },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'agent', label: 'Agent control', icon: Bot },
  { id: 'trusted', label: 'Trusted services', icon: ShieldCheck },
  { id: 'about', label: 'About', icon: CircleHelp }
]

/**
 * Full-page settings, in the spirit of a browser's internal settings page: it lives
 * in the chrome below the toolbar, keeps the tab strip in place, and is closed with
 * the back button or Escape.
 *
 * This component is navigation only. Each section owns its own state, except config
 * and identity state, which live in the two hooks below so unsaved edits survive
 * switching to another section and back.
 */
export function SettingsPage({
  open,
  initialSection,
  onClose,
  onIdentityChange,
  passwordDraftOrigin,
  onPasswordDraftUsed,
  hostingDraft,
  onHostingDraftUsed
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)

  const settings = useBrowserSettings({ open })

  const publishIdentity = (status: IdentityStatus): void => {
    setIdentity(status)
    onIdentityChange?.(status)
  }

  const identityAdmin = useIdentityAdmin({ open, identity, onStatus: publishIdentity })

  useEffect(() => {
    if (!open) return
    setSection(initialSection)
    void window.ncc.identity().then(setIdentity)
    const frame = window.requestAnimationFrame(() => backRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open, initialSection])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <section
      data-settings-page
      aria-label="Settings"
      className="absolute inset-0 z-20 overflow-y-auto bg-[color:var(--color-ink)]"
    >
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-5 py-3">
        <button
          ref={backRef}
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to browsing
        </button>
        <div className="min-w-0">
          <h1 className="text-ui-13 font-semibold text-[color:var(--color-text-strong)]">Settings</h1>
          <p className="truncate text-ui-105 text-[color:var(--color-muted)]">
            Relays, appearance, identity, services, sites, passwords, extensions and signing permissions.
          </p>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-ui-105 text-[color:var(--color-muted)]">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              identity?.configured
                ? 'bg-[color:var(--color-ok)]'
                : 'bg-[color:var(--color-muted)]/50'
            )}
          />
          {identity?.mode === 'nip46'
            ? 'Remote signer'
            : identity?.configured
              ? 'Local key'
              : 'No identity'}
        </span>
      </header>

      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-7 md:flex-row md:px-7">
        <nav aria-label="Settings sections" className="shrink-0 md:w-[190px]">
          <div className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((entry) => {
              const Icon = entry.icon
              const active = entry.id === section
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-settings-section={entry.id}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setSection(entry.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-12 transition-colors',
                    active
                      ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-text-strong)]'
                      : 'text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]'
                  )}
                >
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5',
                      active ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-faint)]'
                    )}
                  />
                  {entry.label}
                </button>
              )
            })}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {section === 'general' ? <GeneralSettings settings={settings.general} /> : null}

          {section === 'appearance' ? (
            <AppearanceSettings
              appearance={settings.appearance.appearance}
              onChange={settings.appearance.change}
              onReset={settings.appearance.reset}
              error={settings.appearance.error}
            />
          ) : null}

          {section === 'security' ? <SecuritySettings settings={settings.security} /> : null}

          {section === 'identity' ? (
            <IdentitySettings identity={identity} admin={identityAdmin} />
          ) : null}

          {section === 'services' ? (
            <HostingSettings
              identity={identity}
              initialDraft={hostingDraft ?? null}
              onDraftUsed={onHostingDraftUsed}
              onOpenIdentity={() => setSection('identity')}
              onIdentityChange={publishIdentity}
              onClose={onClose}
            />
          ) : null}

          {section === 'sites' ? (
            <SitePublishingSettings
              identity={identity}
              onOpenIdentity={() => setSection('identity')}
              onClose={onClose}
            />
          ) : null}

          {section === 'passwords' ? (
            <PasswordSettings
              identity={identity}
              draftOrigin={passwordDraftOrigin ?? null}
              onDraftUsed={onPasswordDraftUsed}
              onOpenIdentity={() => setSection('identity')}
            />
          ) : null}

          {section === 'sync' ? (
            <SyncSettings identity={identity} onOpenIdentity={() => setSection('identity')} />
          ) : null}

          {section === 'extensions' ? <ExtensionSettings /> : null}

          {section === 'agent' ? <AgentSettings /> : null}

          {section === 'trusted' ? <TrustedServices /> : null}

          {section === 'about' ? <AboutSettings /> : null}
        </div>
      </div>
    </section>
  )
}
