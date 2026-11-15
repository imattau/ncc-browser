import { Check, Gauge, Monitor, Moon, Palette, RotateCcw, Sun, Type, ZapOff } from 'lucide-react'
import type {
  AccentPreference,
  AppearanceConfig,
  DensityPreference,
  TextSizePreference,
  ThemePreference
} from '@shared/types'
import { cn } from '../lib/cn'

interface AppearanceSettingsProps {
  appearance: AppearanceConfig
  onChange: (patch: Partial<AppearanceConfig>) => void
  onReset: () => void
  error?: string | null
}

const THEMES: Array<{ id: ThemePreference; label: string; hint: string; icon: typeof Sun }> = [
  { id: 'system', label: 'System', hint: 'Follow the operating system', icon: Monitor },
  { id: 'light', label: 'Light', hint: 'Always light', icon: Sun },
  { id: 'dark', label: 'Dark', hint: 'Always dark', icon: Moon }
]

const TEXT_SIZES: Array<{ id: TextSizePreference; label: string }> = [
  { id: 'small', label: 'Small' },
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' },
  { id: 'xlarge', label: 'Extra large' }
]

const DENSITIES: Array<{ id: DensityPreference; label: string; hint: string }> = [
  { id: 'comfortable', label: 'Comfortable', hint: 'Default spacing' },
  { id: 'compact', label: 'Compact', hint: 'Tighter menus and panels' }
]

const ACCENTS: Array<{ id: AccentPreference; label: string }> = [
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'green', label: 'Green' },
  { id: 'amber', label: 'Amber' }
]

/**
 * Appearance controls. Every change is applied and persisted immediately, in the
 * spirit of a browser's own settings: there is no Save button.
 */
export function AppearanceSettings({
  appearance,
  onChange,
  onReset,
  error
}: AppearanceSettingsProps) {
  return (
    <>
      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">
          Appearance
        </h2>
        <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          Theme, text size, density and accent. Changes apply immediately and are remembered
          across launches.
        </p>
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <Label icon={Monitor} title="Theme" hint="Websites also receive the chosen colour scheme." />
        <div
          role="radiogroup"
          aria-label="Theme"
          className="mt-3 grid grid-cols-3 gap-2"
        >
          {THEMES.map((theme) => {
            const Icon = theme.icon
            const active = appearance.theme === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-theme-option={theme.id}
                title={theme.hint}
                onClick={() => onChange({ theme: theme.id })}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-ui-11 transition-colors',
                  active
                    ? 'border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent)]/10 text-[color:var(--color-text-strong)]'
                    : 'border-[color:var(--color-line)] bg-[color:var(--color-field)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]'
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4',
                    active ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-faint)]'
                  )}
                />
                {theme.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <Label
          icon={Type}
          title="Text size"
          hint="Scales text only. Toolbar and tab heights stay the same."
        />
        <div role="radiogroup" aria-label="Text size" className="mt-3 grid grid-cols-4 gap-2">
          {TEXT_SIZES.map((size) => {
            const active = appearance.textSize === size.id
            return (
              <button
                key={size.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-text-size-option={size.id}
                onClick={() => onChange({ textSize: size.id })}
                className={cn(
                  'rounded-lg border px-2 py-2 text-ui-11 transition-colors',
                  active
                    ? 'border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent)]/10 text-[color:var(--color-text-strong)]'
                    : 'border-[color:var(--color-line)] bg-[color:var(--color-field)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]'
                )}
              >
                {size.label}
              </button>
            )
          })}
        </div>
        <p
          data-text-size-sample
          className="mt-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 leading-relaxed text-[color:var(--color-text)]"
        >
          The quick brown fox jumps over the lazy dog.
        </p>
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <Label
          icon={Gauge}
          title="Density"
          hint="Compact tightens spacing in menus, panels and settings."
        />
        <div role="radiogroup" aria-label="Density" className="mt-3 grid grid-cols-2 gap-2">
          {DENSITIES.map((density) => {
            const active = appearance.density === density.id
            return (
              <button
                key={density.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-density-option={density.id}
                onClick={() => onChange({ density: density.id })}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left text-ui-11 transition-colors',
                  active
                    ? 'border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent)]/10 text-[color:var(--color-text-strong)]'
                    : 'border-[color:var(--color-line)] bg-[color:var(--color-field)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]'
                )}
              >
                <span className="block font-medium">{density.label}</span>
                <span className="mt-0.5 block text-ui-105 text-[color:var(--color-muted)]">
                  {density.hint}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <Label
          icon={Palette}
          title="Accent colour"
          hint="Used for links, focus rings and primary actions."
        />
        <div role="radiogroup" aria-label="Accent colour" className="mt-3 flex flex-wrap gap-2">
          {ACCENTS.map((accent) => {
            const active = appearance.accent === accent.id
            return (
              <button
                key={accent.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={accent.label}
                title={accent.label}
                data-accent-option={accent.id}
                onClick={() => onChange({ accent: accent.id })}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-ui-11 transition-colors',
                  active
                    ? 'border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent)]/10 text-[color:var(--color-text-strong)]'
                    : 'border-[color:var(--color-line)] bg-[color:var(--color-field)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]'
                )}
              >
                <span
                  data-swatch={accent.id}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ background: 'var(--swatch)' }}
                >
                  {active ? <Check className="h-2.5 w-2.5 text-white" /> : null}
                </span>
                {accent.label}
              </button>
            )
          })}
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <input
          type="checkbox"
          data-reduce-motion-toggle
          checked={appearance.reduceMotion}
          onChange={(event) => onChange({ reduceMotion: event.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
        />
        <span>
          <span className="flex items-center gap-1.5 text-ui-12 font-medium text-[color:var(--color-text-strong)]">
            <ZapOff className="h-3.5 w-3.5 text-[color:var(--color-muted)]" />
            Reduce motion
          </span>
          <span className="mt-0.5 block text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
            Disable fade and slide animations in the browser chrome.
          </span>
        </span>
      </label>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <Label icon={Type} title="Preview" hint="A sample of the current appearance." />
        <div
          data-appearance-preview
          className="mt-3 space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3"
        >
          <p className="text-ui-12 leading-relaxed text-[color:var(--color-text)]">
            Pages you trust, signed by their owners. This line follows the selected text size.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-[color:var(--color-accent)] px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]">
              Primary action
            </span>
            <span className="rounded border border-[color:var(--color-ok)]/40 px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-ok)]">
              Verified
            </span>
            <span className="rounded border border-[color:var(--color-warn)]/40 px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-warn)]">
              Warning
            </span>
            <span className="rounded border border-[color:var(--color-danger)]/40 px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-danger)]">
              Failed
            </span>
          </div>
          <p className="text-ui-105 text-[color:var(--color-muted)]">
            Links and focus rings use{' '}
            <span className="font-medium text-[color:var(--color-accent)]">the accent colour</span>.
          </p>
        </div>
      </div>

      {error ? (
        <p className="text-ui-11 text-[color:var(--color-danger)]">{error}</p>
      ) : (
        <p className="text-ui-105 text-[color:var(--color-muted)]">
          Appearance changes are saved automatically.
        </p>
      )}

      <div>
        <button
          type="button"
          data-appearance-reset
          onClick={onReset}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset appearance
        </button>
      </div>
    </>
  )
}

function Label({
  icon: Icon,
  title,
  hint
}: {
  icon: typeof Monitor
  title: string
  hint: string
}) {
  return (
    <div>
      <span className="flex items-center gap-1.5 text-ui-12 font-medium text-[color:var(--color-text-strong)]">
        <Icon className="h-3.5 w-3.5 text-[color:var(--color-muted)]" />
        {title}
      </span>
      <span className="mt-0.5 block text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
        {hint}
      </span>
    </div>
  )
}
