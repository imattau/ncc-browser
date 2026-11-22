import { Trash2 } from 'lucide-react'
import type { ProtectionLevel } from '@shared/types'
import { cn } from '../../lib/cn'
import { CacheRow, SectionHeading } from './shared'
import type { SecuritySettingsApi } from './useBrowserSettings'

/**
 * HTTPS policy, the HTTP interstitial, content protection, per-site exceptions, the
 * site cache and browsing history. Every control here persists from this section.
 */
export function SecuritySettings({ settings }: { settings: SecuritySettingsApi }) {
  const {
    httpsMode,
    setHttpsMode,
    warnInsecure,
    setWarnInsecure,
    protectionLevel,
    setProtectionLevel,
    blockScripts,
    setBlockScripts,
    httpExceptions,
    historyCleared,
    cache,
    cacheBusy,
    cacheNotice,
    cacheError,
    error,
    saved,
    setSaved,
    loading,
    saveSecurity,
    removeHttpException,
    clearHttpExceptions,
    clearBrowsingHistory,
    clearCache
  } = settings

  return (
    <>
      <SectionHeading
        title="Tracking and ads"
        hint="Filter known ads and trackers before requests leave the browser. Strict mode may break some sites."
      />
      <div className="mb-4 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <label htmlFor="protection-level" className="mb-1.5 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">Protection level</label>
        <select id="protection-level" value={protectionLevel} onChange={(event) => { setProtectionLevel(event.target.value as ProtectionLevel); setSaved(false) }} className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 text-[color:var(--color-text)]">
          <option value="off">Off</option>
          <option value="standard">Standard</option>
          <option value="strict">Strict</option>
        </select>
        <label className="mt-3 flex items-center gap-2 text-ui-12 text-[color:var(--color-text)]"><input type="checkbox" checked={blockScripts} onChange={(event) => { setBlockScripts(event.target.checked); setSaved(false) }} /> Block external scripts (may prevent sites from working)</label>
        <button type="button" onClick={() => void saveSecurity()} disabled={loading} className="mt-3 rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-115 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-60">Save protection settings</button>
      </div>

      <SectionHeading
        title="Secure connections"
        hint="Prefer or require HTTPS, and decide how plaintext HTTP is warned about."
      />

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <label
          htmlFor="https-mode"
          className="mb-1.5 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
        >
          HTTPS policy
        </label>
        <select
          id="https-mode"
          value={httpsMode}
          onChange={(event) => {
            setHttpsMode(
              event.target.value === 'off'
                ? 'off'
                : event.target.value === 'only'
                  ? 'only'
                  : 'prefer'
            )
            setSaved(false)
          }}
          className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
        >
          <option value="off">Off — load HTTP normally</option>
          <option value="prefer">Prefer HTTPS — try HTTPS, then fall back with a warning</option>
          <option value="only">HTTPS only — never load HTTP without confirmation</option>
        </select>

        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
          <input
            type="checkbox"
            id="warn-insecure"
            checked={warnInsecure}
            onChange={(event) => {
              setWarnInsecure(event.target.checked)
              setSaved(false)
            }}
            className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
          />
          <span>
            <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
              Ask before loading HTTP pages
            </span>
            <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
              Show a blocking interstitial before a clearnet HTTP page or an NCC HTTP
              endpoint. The amber warning bar appears on HTTP pages either way.
            </span>
          </span>
        </label>

        <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          Loopback addresses and <span className="font-mono">.onion</span> services are
          exempt from automatic HTTPS upgrades. NCC endpoints only use HTTPS when the
          publisher actually published an HTTPS endpoint.
        </p>

        {error ? (
          <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{error}</p>
        ) : saved ? (
          <p className="mt-2 text-ui-12 text-[color:var(--color-ok)]">Saved.</p>
        ) : null}

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void saveSecurity()}
            disabled={loading}
            className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-115 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-60"
          >
            {loading ? 'Saving…' : 'Save security settings'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">HTTP exceptions</h3>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Origins you have explicitly allowed over HTTP. Private and Tor tab exceptions
          live only for that session and are not listed here.
        </p>
        {httpExceptions.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {httpExceptions.map((entry) => (
              <li
                key={entry}
                data-http-exception={entry}
                className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-2"
              >
                <span className="min-w-0 truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
                  {entry}
                </span>
                <button
                  type="button"
                  onClick={() => void removeHttpException(entry)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-ui-105 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-ui-11 text-[color:var(--color-muted)]">
            No HTTP exceptions.
          </p>
        )}
        {httpExceptions.length > 0 ? (
          <button
            type="button"
            onClick={() => void clearHttpExceptions()}
            className="mt-3 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-ui-11 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
          >
            Clear all exceptions
          </button>
        ) : null}
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Browsing history</h3>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Address-bar suggestions use local bookmarks and normal-tab history. Private
          and Tor tabs are never recorded. Clearing removes the history file now.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            data-clear-history
            onClick={() => void clearBrowsingHistory()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-danger)]/30 px-2.5 py-1 text-ui-11 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
          >
            <Trash2 className="h-3 w-3" />
            Clear browsing history
          </button>
          {historyCleared ? (
            <span className="text-ui-11 text-[color:var(--color-ok)]">Cleared.</span>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Cache</h3>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Cached documents, assets and resolved NCC-05 locators. Clearing makes the
          browser fetch them again, but keeps cookies, sign-ins and site data. Cookies
          and storage are cleared per site from the padlock.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-ui-11" data-cache-info>
          <CacheRow label="Normal tabs" bytes={cache?.normal ?? 0} />
          <CacheRow label="Private tabs" bytes={cache?.private ?? 0} />
          <CacheRow label="Tor tabs" bytes={cache?.tor ?? 0} />
          <CacheRow label="Extension pages" bytes={cache?.extensions ?? 0} />
          <CacheRow
            label="Resolved locators"
            value={`${cache?.locators ?? 0} record${cache?.locators === 1 ? '' : 's'}`}
            testId="cache-locators"
          />
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-cache-clear
            disabled={cacheBusy}
            onClick={() => void clearCache()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            {cacheBusy ? 'Clearing…' : 'Clear cache'}
          </button>
          <span
            className={cn(
              'text-ui-11',
              cacheError
                ? 'text-[color:var(--color-danger)]'
                : 'text-[color:var(--color-ok)]'
            )}
          >
            {cacheError ?? cacheNotice}
          </span>
        </div>
      </div>
    </>
  )
}
