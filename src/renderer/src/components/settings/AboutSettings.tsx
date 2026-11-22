import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { AboutRow, SectionHeading, platformName } from './shared'

/** Version rows, the community link and the one-paragraph explanation of NCC-05. */
export function AboutSettings() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.ncc.appInfo().then(setAppInfo)
  }, [])

  return (
    <>
      <SectionHeading
        title="About Nostr Navigator"
        hint="A browser that resolves services through signed Nostr locators instead of DNS."
      />

      <div
        data-about-version
        className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-ui-12 font-medium text-[color:var(--color-text-strong)]">
              Nostr Navigator
            </p>
            <p className="mt-0.5 font-mono text-ui-115 text-[color:var(--color-text)]">
              {appInfo ? `v${appInfo.version}` : 'reading version…'}
            </p>
          </div>
          <span className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 text-ui-10 font-medium text-[color:var(--color-muted)]">
            MIT licence
          </span>
        </div>

        <dl className="mt-3 grid grid-cols-1 gap-1.5 text-ui-11 sm:grid-cols-2">
          <AboutRow label="Electron" value={appInfo?.electron} />
          <AboutRow label="Chromium" value={appInfo?.chromium} />
          <AboutRow
            label="Platform"
            value={appInfo ? `${platformName(appInfo.platform)} ${appInfo.arch}` : undefined}
          />
          <AboutRow label="Licence" value="MIT" />
        </dl>

        <p className="mt-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          Copyright © 2026 imattau. Source, issues and the full licence text live at{' '}
          <span className="font-mono text-[color:var(--color-text-soft)]">
            github.com/imattau/ncc-browser
          </span>
          .
        </p>
      </div>

      <a
        href="https://armada.buzz/invite/naddr1qvzqqqyzz5pzqcqnl9zh37eh4xc4sqgnpvu3escpyxln2c68dd56whn7fu72yje6qqqqtnvsan#BAFVF1BNlW240eS5UPbcx66r"
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 transition-colors hover:border-[color:var(--color-text-soft)] hover:bg-[color:var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
      >
        <img
          src="https://armada.buzz/favicon.ico"
          alt=""
          aria-hidden="true"
          className="h-10 w-10 rounded-lg"
        />
        <span className="min-w-0">
          <span className="block text-ui-12 font-medium text-[color:var(--color-text-strong)]">
            Discuss on Armada
          </span>
          <span className="mt-0.5 block text-ui-11 text-[color:var(--color-muted)]">
            Join the Nostr Navigator community
          </span>
        </span>
      </a>

      <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
        <p>
          An <span className="font-mono text-[color:var(--color-text)]">ncc://npub…/service</span>{' '}
          address is resolved through NCC-05: the npub signs a locator that lists
          endpoints and, optionally, a TLS SPKI fingerprint. No DNS and no
          certificate authority are involved.
        </p>
        <p>
          The address bar shows the npub address you asked for. The endpoint
          host and port stay out of the UI.
        </p>
        <p>
          Bundled Tor is distributed under its own BSD licence; the licence and
          source notice ship in the app&apos;s resources.
        </p>
        <button
          type="button"
          onClick={() => void window.ncc.runCommand('open-spec')}
          className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-ui-115 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
        >
          Read the NCC-05 specification
        </button>
      </div>
    </>
  )
}
