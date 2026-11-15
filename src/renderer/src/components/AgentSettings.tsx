import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, ClipboardCopy, RefreshCw, ShieldAlert, ShieldOff } from 'lucide-react'
import type { AutomationState } from '@shared/automation'

export function AgentSettings() {
  const [state, setState] = useState<AutomationState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState(await window.ncc.automationState())
  }, [])

  useEffect(() => {
    void load().catch((loadError) => setError(messageOf(loadError)))
    return window.ncc.onAutomation(setState)
  }, [load])

  const run = async (action: () => Promise<AutomationState>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setState(await action())
    } catch (runError) {
      setError(messageOf(runError))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    const ok = await window.ncc.automationCopyCommand()
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(false), 2500)
  }

  return (
    <>
      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">
          Agent control
        </h2>
        <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          Let an AI agent such as Claude Code drive ordinary tabs through a local MCP server.
          Private and Tor tabs are never exposed, and the agent must ask you before it first
          acts on each site.
        </p>
      </div>

      {!state ? (
        <p className="text-ui-11 text-[color:var(--color-muted)]">Loading…</p>
      ) : (
        <>
          <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
            <label className="flex cursor-pointer items-start gap-2 text-ui-12 text-[color:var(--color-text-strong)]">
              <input
                type="checkbox"
                data-agent-enable
                checked={state.enabled || state.forced}
                disabled={busy || state.forced}
                onChange={(event) => void run(() => window.ncc.automationSetEnabled(event.target.checked))}
                className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent)]"
              />
              <span>
                Allow agent control
                <span className="mt-0.5 block text-ui-105 text-[color:var(--color-muted)]">
                  {state.forced
                    ? 'Forced on by NCC_AUTOMATION=1.'
                    : state.running
                      ? 'The server is listening on this computer only.'
                      : 'Off. Nothing is listening.'}
                </span>
              </span>
            </label>

            {state.error ? (
              <p className="mt-3 rounded-lg border border-[color:var(--color-danger)]/25 bg-[color:var(--color-danger)]/10 px-2.5 py-2 text-ui-11 text-[color:var(--color-danger)]">
                Could not start: {state.error}
              </p>
            ) : null}
            {error ? <p className="mt-3 text-ui-11 text-[color:var(--color-danger)]">{error}</p> : null}
          </div>

          {state.running && state.url ? (
            <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
              <p className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                <Bot className="h-3.5 w-3.5" />
                Connect Claude Code
              </p>
              <p className="mt-1 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
                Copy the command and run it once in a terminal. The address and token stay the
                same across restarts until you regenerate the token.
              </p>
              <p className="mt-2 break-all rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-2 font-mono text-ui-105 text-[color:var(--color-text-soft)]">
                claude mcp add --transport http ncc-browser {state.url} --header
                &quot;Authorization: Bearer …{state.tokenHint}&quot;
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-agent-copy
                  onClick={() => void copy()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy command'}
                </button>
                <button
                  type="button"
                  data-agent-regenerate
                  disabled={busy}
                  onClick={() => {
                    if (!confirmRegenerate) return setConfirmRegenerate(true)
                    setConfirmRegenerate(false)
                    void run(() => window.ncc.automationRegenerate())
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {confirmRegenerate ? 'Confirm: disconnect current clients' : 'Regenerate token'}
                </button>
              </div>
              <p className="mt-3 flex items-start gap-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The token is stored in this profile. Anyone holding it can request control, but
                still needs your approval for each site.
              </p>
            </div>
          ) : null}

          <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
                Sites the agent can use
              </p>
              <button
                type="button"
                data-agent-revoke-all
                disabled={busy || state.grants.length === 0}
                onClick={() => void run(() => window.ncc.automationRevoke(null))}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
              >
                <ShieldOff className="h-3.5 w-3.5" />
                Stop agent
              </button>
            </div>
            {state.grants.length === 0 ? (
              <p className="mt-2 text-ui-105 text-[color:var(--color-muted)]">
                None. Grants last until the browser quits.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {state.grants.map((site) => (
                  <li
                    key={site}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5"
                  >
                    <span className="min-w-0 truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
                      {site}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => window.ncc.automationRevoke(site))}
                      className="shrink-0 text-ui-11 text-[color:var(--color-muted)] hover:text-[color:var(--color-text-strong)]"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  )
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}
