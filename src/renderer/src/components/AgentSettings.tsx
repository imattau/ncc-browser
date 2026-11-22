import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, ClipboardCopy, Eye, EyeOff, RefreshCw, ShieldAlert, ShieldOff, Trash2 } from 'lucide-react'
import type { AgentSummary, AutomationState } from '@shared/automation'
import { messageOf } from '../lib/format'

export function AgentSettings() {
  const [state, setState] = useState<AutomationState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  // Commands shown in full: either the one-time result of creating/regenerating an agent,
  // or a command just fetched with Reveal. Never persisted beyond this component's state.
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmRegenerate, setConfirmRegenerate] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState(await window.ncc.automationState())
  }, [])

  useEffect(() => {
    void load().catch((loadError) => setError(messageOf(loadError)))
    return window.ncc.onAutomation(setState)
  }, [load])

  const run = async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setBusy(true)
    setError(null)
    try {
      return await action()
    } catch (runError) {
      setError(messageOf(runError))
      return null
    } finally {
      setBusy(false)
    }
  }

  const copy = async (agentId: string, command: string): Promise<void> => {
    const ok = await window.ncc.automationCopyCommand(command)
    setCopied(ok ? agentId : null)
    if (ok) window.setTimeout(() => setCopied((current) => (current === agentId ? null : current)), 2500)
  }

  const addAgent = async (): Promise<void> => {
    const result = await run(() => window.ncc.automationAddAgent(name))
    if (!result) return
    if (result.error) {
      setError(result.error)
      return
    }
    setName('')
    if (result.command) setRevealed((current) => ({ ...current, [agentIdOf(result.state) ?? '']: result.command as string }))
  }

  const regenerate = async (id: string): Promise<void> => {
    setConfirmRegenerate(null)
    const result = await run(() => window.ncc.automationRegenerateIdentity(id))
    if (!result || result.error) {
      if (result?.error) setError(result.error)
      return
    }
    if (result.command) setRevealed((current) => ({ ...current, [id]: result.command as string }))
  }

  const reveal = async (id: string): Promise<void> => {
    if (revealed[id]) {
      setRevealed((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      return
    }
    const command = await run(() => window.ncc.automationRevealCommand(id))
    if (!command) {
      setError('Unlock the password manager first.')
      return
    }
    setRevealed((current) => ({ ...current, [id]: command }))
    window.setTimeout(() => {
      setRevealed((current) => {
        if (!(id in current)) return current
        const next = { ...current }
        delete next[id]
        return next
      })
    }, 15_000)
  }

  const remove = async (id: string): Promise<void> => {
    if (confirmRemove !== id) {
      setConfirmRemove(id)
      return
    }
    setConfirmRemove(null)
    await run(() => window.ncc.automationRemoveAgent(id))
  }

  return (
    <>
      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">
          Agent control
        </h2>
        <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
          Let AI agents such as Claude Code drive ordinary tabs through a local MCP server.
          Each agent gets its own Nostr identity and its own site grants. Private and Tor
          tabs are never exposed, and an agent must ask you before it first acts on each site.
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

          {state.running ? (
            <>
              {state.agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  busy={busy}
                  command={revealed[agent.id] ?? agent.maskedCommand ?? ''}
                  revealed={agent.id in revealed}
                  copied={copied === agent.id}
                  confirmRemove={confirmRemove === agent.id}
                  confirmRegenerate={confirmRegenerate === agent.id}
                  onCopy={() => void copy(agent.id, revealed[agent.id] ?? agent.maskedCommand ?? '')}
                  onReveal={() => void reveal(agent.id)}
                  onRegenerate={() =>
                    confirmRegenerate === agent.id ? void regenerate(agent.id) : setConfirmRegenerate(agent.id)
                  }
                  onRemove={() => void remove(agent.id)}
                  onRevoke={(site) => void run(() => window.ncc.automationRevoke(agent.id, site))}
                  onRevokeSign={(site) => void run(() => window.ncc.automationRevokeSign(agent.id, site))}
                />
              ))}

              <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
                <p className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Add an agent</p>
                <p className="mt-1 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
                  Generates a new Nostr identity for the agent and stores its nsec in the password
                  manager. The password manager must be unlocked.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Agent name (e.g. Claude Code)"
                    className="min-w-[14rem] flex-1 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text-strong)]"
                  />
                  <button
                    type="button"
                    data-agent-add
                    disabled={busy}
                    onClick={() => void addAgent()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    Add agent
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  )
}

function AgentCard(props: {
  agent: AgentSummary
  busy: boolean
  command: string
  revealed: boolean
  copied: boolean
  confirmRemove: boolean
  confirmRegenerate: boolean
  onCopy: () => void
  onReveal: () => void
  onRegenerate: () => void
  onRemove: () => void
  onRevoke: (site: string | null) => void
  onRevokeSign: (site: string | null) => void
}) {
  const { agent } = props

  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
            <Bot className="h-3.5 w-3.5" />
            {agent.name}
          </p>
          <p className="mt-0.5 break-all font-mono text-ui-105 text-[color:var(--color-muted)]">
            {agent.npub ?? 'No Nostr id yet — regenerate its identity to create one.'}
          </p>
        </div>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onRemove}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-danger)] disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {props.confirmRemove ? 'Confirm: remove agent' : 'Remove'}
        </button>
      </div>

      <p className="mt-3 break-all rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-2 font-mono text-ui-105 text-[color:var(--color-text-soft)]">
        {props.command}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-agent-copy
          onClick={props.onCopy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]"
        >
          {props.copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
          {props.copied ? 'Copied' : 'Copy command'}
        </button>
        <button
          type="button"
          data-agent-reveal
          onClick={props.onReveal}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)]"
        >
          {props.revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {props.revealed ? 'Hide' : 'Reveal'}
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onRegenerate}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {props.confirmRegenerate ? 'Confirm: disconnect this agent' : 'Regenerate identity'}
        </button>
      </div>
      <p className="mt-3 flex items-start gap-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        The nsec above authenticates this agent. Anyone holding it can request control, but
        still needs your approval for each site.
      </p>

      <GrantsSection
        title="Sites this agent can use"
        emptyText="None. Grants last until the browser quits."
        stopLabel="Stop agent"
        sites={agent.grants}
        busy={props.busy}
        onRevoke={props.onRevoke}
      />
      <GrantsSection
        title="Sites this agent can sign in to"
        emptyText="None. The agent must ask before signing in anywhere, using its own Nostr identity."
        stopLabel="Stop signing"
        sites={agent.signGrants}
        busy={props.busy}
        onRevoke={props.onRevokeSign}
      />
    </div>
  )
}

function GrantsSection(props: {
  title: string
  emptyText: string
  stopLabel: string
  sites: string[]
  busy: boolean
  onRevoke: (site: string | null) => void
}) {
  return (
    <div className="mt-3 border-t border-[color:var(--color-line)] pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ui-11 font-semibold text-[color:var(--color-text-strong)]">{props.title}</p>
        <button
          type="button"
          disabled={props.busy || props.sites.length === 0}
          onClick={() => props.onRevoke(null)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
        >
          <ShieldOff className="h-3.5 w-3.5" />
          {props.stopLabel}
        </button>
      </div>
      {props.sites.length === 0 ? (
        <p className="mt-2 text-ui-105 text-[color:var(--color-muted)]">{props.emptyText}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {props.sites.map((site) => (
            <li
              key={site}
              className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] px-2.5 py-1.5"
            >
              <span className="min-w-0 truncate font-mono text-ui-11 text-[color:var(--color-text-soft)]">
                {site}
              </span>
              <button
                type="button"
                disabled={props.busy}
                onClick={() => props.onRevoke(site)}
                className="shrink-0 text-ui-11 text-[color:var(--color-muted)] hover:text-[color:var(--color-text-strong)]"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function agentIdOf(state: AutomationState): string | undefined {
  // The newest agent is appended last by AutomationSettings.addAgent.
  return state.agents.at(-1)?.id
}
