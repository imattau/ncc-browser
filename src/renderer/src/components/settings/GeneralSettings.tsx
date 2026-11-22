import { Globe, RotateCcw, Search, Trash2 } from 'lucide-react'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/search'
import { DEFAULT_RELAYS, DEFAULT_TOR_SOCKS, type RelayEntry } from '@shared/types'
import { cn } from '../../lib/cn'
import { durationFromNow, shortIdentity } from '../../lib/format'
import { SectionHeading, torStatusText } from './shared'
import type { GeneralSettingsApi } from './useBrowserSettings'

/** One relay entry: endpoint, locator provenance, pin and expiry. */
function RelayRow({
  entry,
  onRemove
}: {
  entry: RelayEntry
  onRemove: (url: string) => void
}) {
  const locator = entry.locator
  return (
    <li className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
            entry.stale ? 'bg-[color:var(--color-danger)]' : 'bg-[color:var(--color-ok)]'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-all font-mono text-ui-12 text-[color:var(--color-text)]">{entry.url}</span>
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-ui-10 font-medium',
                locator
                  ? 'border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                  : 'border-[color:var(--color-line)] text-[color:var(--color-muted)]'
              )}
            >
              {locator ? 'Identity' : 'Direct'}
            </span>
            {entry.stale ? (
              <span className="rounded border border-[color:var(--color-danger)]/40 px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-danger)]">
                Stale locator
              </span>
            ) : null}
          </div>
          {locator ? (
            <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
              {shortIdentity(locator.identity, 16, 6)} · {locator.service} · expires in{' '}
              {durationFromNow(locator.expiresAt)}
              {locator.k ? ` · pin ${locator.k.slice(0, 10)}…` : ' · no pin published'}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={`Remove ${entry.url}`}
          onClick={() => onRemove(entry.url)}
          className="rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  )
}

/**
 * Relays and resolution policy, NIP-65 gossip, NCC-02 anchoring, public-address
 * checks, Tor and search. One Save button persists the whole group.
 */
export function GeneralSettings({ settings }: { settings: GeneralSettingsApi }) {
  const {
    relayEntries,
    setRelayEntries,
    newRelay,
    setNewRelay,
    relayBusy,
    gossip,
    setGossip,
    anchorRequired,
    setAnchorRequired,
    externalAddressChecks,
    setExternalAddressChecks,
    preferTor,
    setPreferTor,
    torMode,
    setTorMode,
    torSocks,
    setTorSocks,
    torStatus,
    torBusy,
    searchEngine,
    setSearchEngine,
    searchCustom,
    setSearchCustom,
    useOnionSearch,
    setUseOnionSearch,
    nccSearchEnabled,
    setNccSearchEnabled,
    error,
    setError,
    saved,
    setSaved,
    loading,
    addRelay,
    removeRelay,
    save,
    testTor
  } = settings

  return (
    <>
      <SectionHeading
        title="Relays & resolution"
        hint="Where NCC-05 locators are looked up. Add a wss:// address or an ncc:// identity."
      />

      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <label className="mb-2 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
          Resolution relays
        </label>

        <ul className="space-y-2">
          {relayEntries.map((entry) => (
            <RelayRow
              key={
                entry.locator
                  ? `${entry.locator.identity}/${entry.locator.service}`
                  : entry.url
              }
              entry={entry}
              onRemove={removeRelay}
            />
          ))}
        </ul>

        <div className="mt-3 flex gap-2">
          <input
            id="new-relay"
            value={newRelay}
            onChange={(event) => {
              setNewRelay(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !relayBusy) {
                event.preventDefault()
                void addRelay()
              }
            }}
            placeholder="wss://relay.example or ncc://npub1…/relay"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
          />
          <button
            type="button"
            disabled={relayBusy || newRelay.trim().length === 0}
            onClick={() => void addRelay()}
            className="rounded-lg border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-3 py-1.5 text-ui-11 font-semibold text-[color:var(--color-accent)] disabled:opacity-40"
          >
            {relayBusy ? 'Resolving…' : 'Add'}
          </button>
        </div>

        <p className="mt-2 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          An <span className="font-mono">ncc://</span> relay is resolved from the
          identity&apos;s NCC-05 locator and re-resolved before it expires. The
          locator&apos;s <span className="font-mono">k</span> fingerprint is enforced
          as a TLS pin, so a self-signed relay is accepted only when it matches.
        </p>

        {error ? (
          <p className="mt-2 text-ui-12 text-[color:var(--color-danger)]">{error}</p>
        ) : saved ? (
          <p className="mt-2 text-ui-12 text-[color:var(--color-ok)]">
            Saved. The resolver and locator cache were cleared.
          </p>
        ) : (
          <p className="mt-2 text-ui-12 text-[color:var(--color-muted)]">
            Defaults: {DEFAULT_RELAYS.join(', ')}
          </p>
        )}

        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
          <input
            type="checkbox"
            checked={gossip}
            onChange={(event) => {
              setGossip(event.target.checked)
              setSaved(false)
            }}
            className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
          />
          <span>
            <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
              Follow NIP-65 relay hints
            </span>
            <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
              Ask the target identity&apos;s relay list where it actually publishes.
              More reliable, at the cost of one extra metadata lookup on the
              configured relays.
            </span>
          </span>
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
          <input
            type="checkbox"
            id="anchor-required"
            checked={anchorRequired}
            onChange={(event) => {
              setAnchorRequired(event.target.checked)
              setSaved(false)
            }}
            className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
          />
          <span>
            <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
              Require NCC-02 service records
            </span>
            <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
              Fail closed unless the identity publishes a fresh kind 30059 service
              record with the same service id. Publishing a service or share also
              fails if its anchor cannot be published; private anchors omit the
              endpoint. When off, NCC-02 is shown as an optional trust anchor.
            </span>
          </span>
        </label>

        <div className="mt-4 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
          <label
            htmlFor="external-address-checks"
            className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]"
          >
            Check public address when publishing
          </label>
          <p className="mt-0.5 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
            Endpoint discovery can confirm what the internet sees by contacting{' '}
            <span className="font-mono">api64.ipify.org</span>. That service sees your IP
            address, not your identity or services. It never runs while Tor is preferred.
          </p>
          <select
            id="external-address-checks"
            value={externalAddressChecks}
            onChange={(event) => {
              setExternalAddressChecks(
                event.target.value === 'always' || event.target.value === 'never'
                  ? event.target.value
                  : 'ask'
              )
              setSaved(false)
            }}
            className="mt-2 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-1.5 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
          >
            <option value="ask">Ask before checking (recommended)</option>
            <option value="always">Check automatically</option>
            <option value="never">Never contact an external service</option>
          </select>
        </div>

        <div className="mt-4 border-t border-[color:var(--color-line)] pt-4">
          <div className="flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-[color:var(--color-violet-strong)]" />
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Tor</h3>
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
            <input
              type="checkbox"
              id="prefer-tor"
              checked={preferTor}
              onChange={(event) => {
                setPreferTor(event.target.checked)
                setSaved(false)
              }}
              className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
            />
            <span>
              <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                Prefer Tor connections
              </span>
              <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                When a locator publishes an onion endpoint, load the service over Tor
                instead of its direct endpoints. Records without an onion endpoint
                load normally.
              </span>
            </span>
          </label>

          <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
            <label
              htmlFor="tor-mode"
              className="mb-1.5 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
            >
              Tor proxy
            </label>
            <select
              id="tor-mode"
              value={torMode}
              onChange={(event) => {
                setTorMode(event.target.value === 'local' ? 'local' : 'auto')
                setSaved(false)
              }}
              className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field-alt)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
            >
              <option value="auto">Automatic (bundled Tor, then local)</option>
              <option value="local">Local SOCKS proxy</option>
            </select>

            {torMode === 'local' ? (
              <input
                value={torSocks}
                onChange={(event) => {
                  setTorSocks(event.target.value)
                  setSaved(false)
                }}
                placeholder={DEFAULT_TOR_SOCKS}
                spellCheck={false}
                autoComplete="off"
                aria-label="Tor SOCKS proxy"
                className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field-alt)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
              />
            ) : (
              <p className="mt-2 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
                Starts the bundled Tor. If it cannot start, the browser tries a local
                proxy on 127.0.0.1:9050 or 9150.
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p
                data-tor-status
                className={cn(
                  'text-ui-11 leading-relaxed',
                  torStatus?.error
                    ? 'text-[color:var(--color-warn)]'
                    : 'text-[color:var(--color-muted)]'
                )}
              >
                {torStatusText(torStatus)}
              </p>
              <button
                type="button"
                disabled={torBusy || loading}
                onClick={() => void testTor()}
                className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-40"
              >
                {torBusy ? 'Checking…' : 'Test saved connection'}
              </button>
            </div>

            {torStatus?.error ? (
              <p className="mt-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
                {torStatus.error}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 border-t border-[color:var(--color-line)] pt-4">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Search</h3>
          </div>

          <label
            htmlFor="search-engine"
            className="mb-1.5 mt-3 block text-ui-105 font-semibold uppercase tracking-wide text-[color:var(--color-muted)]"
          >
            Search engine
          </label>
          <select
            id="search-engine"
            value={searchEngine}
            onChange={(event) => {
              setSearchEngine(event.target.value as SearchEngineId)
              setSaved(false)
            }}
            className="w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
          >
            {SEARCH_ENGINES.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.label}
              </option>
            ))}
          </select>

          {searchEngine === 'searx' ? (
            <input
              id="searx-url"
              value={searchCustom}
              onChange={(event) => {
                setSearchCustom(event.target.value)
                setSaved(false)
              }}
              placeholder="https://searx.example"
              spellCheck={false}
              autoComplete="off"
              aria-label="SearXNG instance URL"
              className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
            />
          ) : null}

          {searchEngine === 'custom' ? (
            <input
              id="search-custom"
              value={searchCustom}
              onChange={(event) => {
                setSearchCustom(event.target.value)
                setSaved(false)
              }}
              placeholder="https://…/?q=%s or ncc://…/?q=%s"
              spellCheck={false}
              autoComplete="off"
              aria-label="Custom search URL"
              className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-3 py-2 font-mono text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60"
            />
          ) : null}

          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
            <input
              type="checkbox"
              id="search-onion"
              checked={useOnionSearch}
              onChange={(event) => {
                setUseOnionSearch(event.target.checked)
                setSaved(false)
              }}
              className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
            />
            <span>
              <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                Use onion search in Tor tabs
              </span>
              <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                DuckDuckGo publishes an onion endpoint; full Tor tabs use it so the
                search query never leaves the Tor network. Other engines use their
                normal URL over Tor.
              </span>
            </span>
          </label>

          <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3.5">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={nccSearchEnabled}
                onChange={(event) => {
                  setNccSearchEnabled(event.target.checked)
                  setSaved(false)
                }}
                className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
              />
              <span>
                <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
                  Enable local nccsearch
                </span>
                <span className="mt-0.5 block text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
                  Crawls your configured relays while open and keeps its index on this device. Search activity is not published.
                </span>
              </span>
            </label>
          </div>

          <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
            Suggestions come from bookmarks, open tabs and normal-tab history. The
            browser never asks the engine for suggestions as you type: the query is
            sent only when you press Enter. Custom search templates can use an
            <span className="font-mono"> ncc://</span> service address. Plaintext HTTP
            search URLs are allowed only for loopback and .onion hosts.
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setRelayEntries(DEFAULT_RELAYS.map((url) => ({ url })))
              setAnchorRequired(false)
              setPreferTor(false)
              setTorMode('auto')
              setTorSocks(DEFAULT_TOR_SOCKS)
              setSearchEngine('duckduckgo')
              setSearchCustom('')
              setUseOnionSearch(true)
              setSaved(false)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-115 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading}
            className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-ui-115 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-60"
          >
            {loading ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </>
  )
}
