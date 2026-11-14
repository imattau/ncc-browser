import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import {
  DEFAULT_ANCHOR_DAYS,
  DEFAULT_RELAYS,
  DEFAULT_SERVICE,
  DEFAULT_TTL_SECONDS,
  buildAnchorTemplate,
  buildLocatorContent,
  buildLocatorTemplate,
  buildNccAddress,
  endpointUrl,
  newEndpoint,
  parseRelayList,
  validateDraft,
  type EndpointDraft,
  type PublisherDraft
} from './lib/locator'
import { detectSigner, type Nip07Signer } from './lib/nostr'
import { publishEvents, signTemplates, type RelayReport } from './lib/publish'
import { cn } from './lib/cn'

const STORAGE_KEY = 'ncc-publisher-form-v1'

interface StoredForm {
  service: string
  endpoints: EndpointDraft[]
  ttl: string
  relayText: string
  encrypt: boolean
  publishAnchor: boolean
  anchorDays: string
  notes: string
}

function loadStored(): Partial<StoredForm> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<StoredForm>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const stored = typeof window === 'undefined' ? {} : loadStored()

function endpointFrom(value: unknown): EndpointDraft {
  const base = newEndpoint()
  if (!value || typeof value !== 'object') return base
  const endpoint = value as Partial<EndpointDraft>
  return {
    ...base,
    ...endpoint,
    priority: Number.isFinite(Number(endpoint.priority)) ? Number(endpoint.priority) : base.priority
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}

interface PublishResult {
  address: string
  reports: RelayReport[]
  events: Array<{ id: string; kind: number }>
  encrypted: boolean
  anchor: boolean
}

export function App() {
  const [service, setService] = useState(stored.service ?? DEFAULT_SERVICE)
  const [endpoints, setEndpoints] = useState<EndpointDraft[]>(() => {
    const saved = Array.isArray(stored.endpoints) ? stored.endpoints.map(endpointFrom) : []
    return saved.length > 0 ? saved : [newEndpoint()]
  })
  const [ttl, setTtl] = useState(stored.ttl ?? String(DEFAULT_TTL_SECONDS))
  const [relayText, setRelayText] = useState(stored.relayText ?? DEFAULT_RELAYS.join('\n'))
  const [encrypt, setEncrypt] = useState(stored.encrypt === true)
  const [publishAnchor, setPublishAnchor] = useState(stored.publishAnchor !== false)
  const [anchorDays, setAnchorDays] = useState(stored.anchorDays ?? String(DEFAULT_ANCHOR_DAYS))
  const [notes, setNotes] = useState(stored.notes ?? '')

  const [signerAvailable, setSignerAvailable] = useState<boolean | null>(null)
  const [pubkey, setPubkey] = useState<string | null>(null)
  const [signerBusy, setSignerBusy] = useState(false)
  const [signerError, setSignerError] = useState<string | null>(null)
  const signerRef = useRef<Nip07Signer | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const signer = detectSigner()
    signerRef.current = signer
    setSignerAvailable(Boolean(signer))
  }, [])

  useEffect(() => {
    const payload: StoredForm = {
      service,
      endpoints,
      ttl,
      relayText,
      encrypt,
      publishAnchor,
      anchorDays,
      notes
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // storage may be unavailable in private contexts
    }
  }, [service, endpoints, ttl, relayText, encrypt, publishAnchor, anchorDays, notes])

  const connectSigner = useCallback(async () => {
    const signer = detectSigner()
    signerRef.current = signer
    setSignerAvailable(Boolean(signer))
    if (!signer) {
      setSignerError('No NIP-07 signer found on this page.')
      return
    }

    setSignerBusy(true)
    setSignerError(null)
    try {
      const next = await signer.getPublicKey()
      setPubkey(next)
    } catch (connectError) {
      setSignerError(errorMessage(connectError))
    } finally {
      setSignerBusy(false)
    }
  }, [])

  const npub = useMemo(() => {
    if (!pubkey) return null
    try {
      return nip19.npubEncode(pubkey)
    } catch {
      return null
    }
  }, [pubkey])

  const relays = useMemo(() => parseRelayList(relayText), [relayText])
  const draft: PublisherDraft = useMemo(
    () => ({
      service,
      ttl: Number(ttl),
      endpoints,
      relays,
      encrypt,
      publishAnchor,
      anchorDays: Number(anchorDays),
      notes
    }),
    [service, ttl, endpoints, relays, encrypt, publishAnchor, anchorDays, notes]
  )
  const errors = useMemo(() => validateDraft(draft), [draft])

  const previewNow = Math.floor(Date.now() / 1000)
  const previewPayload = useMemo(
    () => buildLocatorContent(draft, previewNow),
    // The preview intentionally reflects the current form; the timestamp is cosmetic.
    [draft, previewNow]
  )
  const previewAnchor = useMemo(
    () => buildAnchorTemplate(draft, previewNow),
    [draft, previewNow]
  )
  const address = npub ? buildNccAddress(npub, service) : null
  const primaryUrl = endpoints[0] ? endpointUrl(endpoints[0]) : ''

  const updateEndpoint = (index: number, patch: Partial<EndpointDraft>): void => {
    setEndpoints((current) =>
      current.map((endpoint, itemIndex) =>
        itemIndex === index ? { ...endpoint, ...patch } : endpoint
      )
    )
  }

  const removeEndpoint = (index: number): void => {
    setEndpoints((current) => (current.length === 1 ? current : current.filter((_, i) => i !== index)))
  }

  const copy = async (value: string, key: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500)
    } catch {
      setCopied('failed')
    }
  }

  const publish = async (): Promise<void> => {
    if (!npub || !pubkey) {
      setError('Connect a NIP-07 signer before publishing.')
      return
    }
    if (errors.length > 0) {
      setError(errors[0])
      return
    }

    const signer = signerRef.current ?? detectSigner()
    if (!signer) {
      setError('No NIP-07 signer found.')
      return
    }

    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const now = Math.floor(Date.now() / 1000)
      const plaintext = buildLocatorContent(draft, now)
      let content = plaintext
      if (encrypt) {
        if (!signer.nip44) throw new Error('This signer does not implement NIP-44 encryption.')
        content = await signer.nip44.encrypt(pubkey, plaintext)
      }

      const templates = [buildLocatorTemplate(draft, content, now)]
      const anchor = buildAnchorTemplate(draft, now)
      if (anchor) templates.push(anchor)

      const events = await signTemplates(signer, templates)
      const reports = await publishEvents(draft.relays, events)
      setResult({
        address: buildNccAddress(npub, service),
        reports,
        events: events.map((event) => ({ id: event.id, kind: event.kind })),
        encrypted: encrypt,
        anchor: Boolean(anchor)
      })
    } catch (publishError) {
      setError(errorMessage(publishError))
    } finally {
      setBusy(false)
    }
  }

  const resetForm = (): void => {
    setService(DEFAULT_SERVICE)
    setEndpoints([newEndpoint()])
    setTtl(String(DEFAULT_TTL_SECONDS))
    setRelayText(DEFAULT_RELAYS.join('\n'))
    setEncrypt(false)
    setPublishAnchor(true)
    setAnchorDays(String(DEFAULT_ANCHOR_DAYS))
    setNotes('')
    setResult(null)
    setError(null)
  }

  const accepted = result?.reports.filter((report) => report.ok).length ?? 0
  const canPublish = Boolean(npub) && errors.length === 0 && !busy

  return (
    <div className="min-h-screen bg-[color:var(--color-ink)]">
      <header className="border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
              <Radio className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-[15px] font-semibold text-[#e7e9ef]">NCC Publisher</h1>
              <p className="text-[11.5px] text-[color:var(--color-muted)]">
                Sign a locator for a local port and publish it to Nostr relays.
              </p>
            </div>
          </div>
          <SignerStatus
            available={signerAvailable}
            pubkey={pubkey}
            npub={npub}
            busy={signerBusy}
            error={signerError}
            onConnect={() => void connectSigner()}
          />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_370px]">
        <div className="space-y-5">
          <Card title="Service" hint="The identity is your signer's npub; this is the NCC-05 d tag.">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
              <Field label="Service id">
                <input
                  value={service}
                  onChange={(event) => setService(event.target.value)}
                  spellCheck={false}
                  placeholder="web"
                  aria-label="Service id"
                  className={inputClass}
                />
              </Field>
              <Field label="TTL (seconds)">
                <input
                  value={ttl}
                  onChange={(event) => setTtl(event.target.value)}
                  inputMode="numeric"
                  aria-label="TTL"
                  className={inputClass}
                />
              </Field>
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3">
              <input
                type="checkbox"
                checked={publishAnchor}
                onChange={(event) => setPublishAnchor(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-[#e7e9ef]">
                  Also publish an NCC-02 service record
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-[color:var(--color-muted)]">
                  Adds a kind 30059 identity anchor with the primary endpoint and transport
                  key. The browser shows it as <span className="font-mono">anchored</span>.
                </span>
              </span>
            </label>

            {publishAnchor ? (
              <div className="mt-3 sm:w-[180px]">
                <Field label="NCC-02 expiry (days)">
                  <input
                    value={anchorDays}
                    onChange={(event) => setAnchorDays(event.target.value)}
                    inputMode="numeric"
                    aria-label="Anchor expiry days"
                    className={inputClass}
                  />
                </Field>
              </div>
            ) : null}

            <Field label="Notes (optional)" className="mt-3">
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={2}
                placeholder="Public test service"
                aria-label="Notes"
                className={textareaClass}
              />
            </Field>
          </Card>

          <Card
            title="Endpoints"
            hint="Use 127.0.0.1 for this machine, or a LAN address for another device. The first endpoint is used for the NCC-02 anchor."
            action={
              <button
                type="button"
                onClick={() => setEndpoints((current) => [...current, newEndpoint()])}
                className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-[11px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            }
          >
            <div className="space-y-3">
              {endpoints.map((endpoint, index) => (
                <div
                  key={index}
                  className="rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                      {index === 0 ? 'Primary endpoint' : `Endpoint ${index + 1}`}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove endpoint ${index + 1}`}
                      disabled={endpoints.length === 1}
                      onClick={() => removeEndpoint(index)}
                      className="rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-[color:var(--color-danger)] disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)_84px]">
                    <select
                      value={endpoint.scheme}
                      aria-label="Scheme"
                      onChange={(event) =>
                        updateEndpoint(index, {
                          scheme: event.target.value as EndpointDraft['scheme']
                        })
                      }
                      className={inputClass}
                    >
                      <option value="http">http</option>
                      <option value="https">https</option>
                      <option value="ws">ws</option>
                      <option value="wss">wss</option>
                      <option value="onion">onion</option>
                    </select>
                    <input
                      value={endpoint.host}
                      onChange={(event) => updateEndpoint(index, { host: event.target.value })}
                      spellCheck={false}
                      placeholder="127.0.0.1"
                      aria-label="Host"
                      className={inputClass}
                    />
                    <input
                      value={endpoint.port}
                      onChange={(event) => updateEndpoint(index, { port: event.target.value })}
                      inputMode="numeric"
                      placeholder="8080"
                      aria-label="Port"
                      className={inputClass}
                    />
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px_90px]">
                    <input
                      value={endpoint.path}
                      onChange={(event) => updateEndpoint(index, { path: event.target.value })}
                      spellCheck={false}
                      placeholder="Path (optional)"
                      aria-label="Path"
                      className={inputClass}
                    />
                    <select
                      value={endpoint.family}
                      onChange={(event) =>
                        updateEndpoint(index, {
                          family: event.target.value as EndpointDraft['family']
                        })
                      }
                      aria-label="Family"
                      className={inputClass}
                    >
                      <option value="">auto family</option>
                      <option value="ipv4">ipv4</option>
                      <option value="ipv6">ipv6</option>
                      <option value="onion">onion</option>
                    </select>
                    <input
                      value={endpoint.priority}
                      onChange={(event) =>
                        updateEndpoint(index, { priority: Number(event.target.value) })
                      }
                      inputMode="numeric"
                      aria-label="Priority"
                      placeholder="1000"
                      className={inputClass}
                    />
                  </div>

                  <input
                    value={endpoint.k}
                    onChange={(event) => updateEndpoint(index, { k: event.target.value })}
                    spellCheck={false}
                    placeholder="TLS SPKI fingerprint k (optional)"
                    aria-label="Transport key fingerprint"
                    className={`${inputClass} mt-2 font-mono`}
                  />

                  <p className="mt-1.5 truncate font-mono text-[10.5px] text-[#5d6575]">
                    {endpointUrl(endpoint)}
                  </p>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Relays"
            hint={`${relays.length} valid relay${relays.length === 1 ? '' : 's'} · ws:// or wss:// only`}
            action={
              <button
                type="button"
                onClick={() => setRelayText(DEFAULT_RELAYS.join('\n'))}
                className="inline-flex items-center gap-1 rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-[11px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
              >
                <RefreshCw className="h-3 w-3" />
                Defaults
              </button>
            }
          >
            <textarea
              value={relayText}
              onChange={(event) => setRelayText(event.target.value)}
              rows={4}
              spellCheck={false}
              aria-label="Relays"
              className={textareaClass}
            />
          </Card>

          <Card title="Privacy" hint="Plaintext is easiest to test; encryption needs the same identity in the reader.">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3">
              <input
                type="checkbox"
                checked={encrypt}
                onChange={(event) => setEncrypt(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
              />
              <span>
                <span className="block text-[12px] font-medium text-[#e7e9ef]">
                  Encrypt the locator to my own key (NIP-44)
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-[color:var(--color-muted)]">
                  Relays see only ciphertext. The browser must use the same local key or
                  NIP-46 remote signer to decrypt this record.
                </span>
              </span>
            </label>
          </Card>

          {errors.length > 0 ? (
            <div className="rounded-xl border border-[color:var(--color-warn)]/25 bg-[color:var(--color-warn)]/[0.06] p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[color:var(--color-warn)]">
                <AlertTriangle className="h-3.5 w-3.5" />
                Fix before publishing
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[11px] text-[color:var(--color-muted)]">
                {errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {error ? (
            <p className="rounded-xl border border-[color:var(--color-danger)]/25 bg-[color:var(--color-danger)]/[0.06] px-3 py-2 text-[11.5px] text-[color:var(--color-danger)]">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg px-3 py-2 text-[11.5px] text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
            >
              Reset form
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={!canPublish}
              className="inline-flex items-center gap-2 rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#0b0c10]/30 border-t-[#0b0c10]" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {busy ? 'Signing & publishing…' : 'Sign & publish'}
            </button>
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
          <Card title="Address">
            {address ? (
              <div className="space-y-2">
                <div className="flex items-start gap-2 rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] p-2.5">
                  <code className="min-w-0 flex-1 break-all font-mono text-[10.5px] leading-relaxed text-[#c9d1e0]">
                    {address}
                  </code>
                  <button
                    type="button"
                    aria-label="Copy NCC address"
                    onClick={() => void copy(address, 'address')}
                    className="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
                  >
                    {copied === 'address' ? (
                      <Check className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <p className="text-[10.5px] leading-relaxed text-[color:var(--color-muted)]">
                  Open this in NCC Browser. The address stays stable when the port or host
                  changes; republish the locator instead.
                </p>
              </div>
            ) : (
              <p className="text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                Connect a NIP-07 signer to derive the npub and the address.
              </p>
            )}
          </Card>

          <Card title="Preview" hint="The exact payload that will be signed.">
            <pre className="max-h-[260px] overflow-auto rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] p-2.5 font-mono text-[10px] leading-relaxed text-[#c9d1e0]">
              {previewPayload}
            </pre>
            {encrypt ? (
              <p className="mt-2 text-[10.5px] text-[color:var(--color-warn)]">
                This payload will be NIP-44 encrypted before signing.
              </p>
            ) : null}
            {previewAnchor ? (
              <div className="mt-3 border-t border-[color:var(--color-line)] pt-2.5">
                <p className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                  <ShieldCheck className="h-3 w-3 text-[color:var(--color-ok)]" />
                  NCC-02 anchor
                </p>
                <pre className="max-h-[130px] overflow-auto rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] p-2.5 font-mono text-[10px] leading-relaxed text-[#c9d1e0]">
                  {JSON.stringify(
                    { kind: previewAnchor.kind, tags: previewAnchor.tags, content: '' },
                    null,
                    2
                  )}
                </pre>
              </div>
            ) : null}
          </Card>

          {result ? (
            <Card
              title={accepted > 0 ? 'Published' : 'Not accepted'}
              hint={`${accepted}/${result.reports.length} relay${result.reports.length === 1 ? '' : 's'} accepted`}
            >
              <div className="space-y-2 text-[11px]">
                <p className="font-mono text-[10.5px] text-[#c9d1e0]">{result.address}</p>
                <div className="flex flex-wrap gap-1.5">
                  {result.encrypted ? (
                    <span className="rounded border border-[color:var(--color-accent)]/25 bg-[color:var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] text-[color:var(--color-accent)]">
                      NIP-44 encrypted
                    </span>
                  ) : null}
                  {result.anchor ? (
                    <span className="rounded border border-[color:var(--color-ok)]/25 bg-[color:var(--color-ok)]/10 px-1.5 py-0.5 text-[10px] text-[color:var(--color-ok)]">
                      NCC-02 anchor
                    </span>
                  ) : null}
                </div>
                <ul className="space-y-1">
                  {result.reports.map((report) => (
                    <li
                      key={report.relay}
                      className="flex items-start justify-between gap-2 rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] px-2 py-1.5"
                    >
                      <span className="min-w-0 break-all font-mono text-[9.5px] text-[#c9d1e0]">
                        {report.relay}
                      </span>
                      {report.ok ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-ok)]" />
                      ) : (
                        <X className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-danger)]" />
                      )}
                    </li>
                  ))}
                </ul>
                <p className="font-mono text-[9.5px] text-[#5d6575]">
                  {result.events.map((event) => `kind ${event.kind} ${event.id.slice(0, 12)}…`).join(' · ')}
                </p>
              </div>
            </Card>
          ) : null}

          <Card title="Check the service">
            <p className="text-[11px] leading-relaxed text-[color:var(--color-muted)]">
              The endpoint must be reachable from the device running NCC Browser. Use
              <span className="font-mono text-[#dfe3ea]"> 127.0.0.1 </span>
              when both run on this machine, or a LAN address otherwise.
            </p>
            {primaryUrl ? (
              <a
                href={primaryUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-[11px] text-[#dfe3ea] hover:bg-white/5"
              >
                <ExternalLink className="h-3 w-3" />
                Open primary endpoint
              </a>
            ) : null}
          </Card>
        </aside>
      </main>

      <footer className="mx-auto max-w-6xl px-5 pb-8 pt-2 text-[10.5px] leading-relaxed text-[#5d6575]">
        NCC Publisher is a separate MKStack-style app. It never asks for an nsec: events
        are signed by your NIP-07 provider. Built with React, Vite, Tailwind and
        nostr-tools. See the NCC-05 specification for the locator format.
      </footer>
    </div>
  )
}

function SignerStatus({
  available,
  pubkey,
  npub,
  busy,
  error,
  onConnect
}: {
  available: boolean | null
  pubkey: string | null
  npub: string | null
  busy: boolean
  error: string | null
  onConnect: () => void
}) {
  if (pubkey && npub) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[color:var(--color-ok)]/25 bg-[color:var(--color-ok)]/[0.06] px-3 py-2">
        <KeyRound className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)]">
            Signer connected
          </p>
          <p className="max-w-[220px] truncate font-mono text-[10.5px] text-[#dfe3ea]" title={npub}>
            {npub}
          </p>
        </div>
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className="ml-1 rounded p-1 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white disabled:opacity-40"
          aria-label="Refresh signer"
          title="Refresh signer"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {available === false ? (
        <span className="max-w-[330px] text-[10.5px] leading-relaxed text-[color:var(--color-warn)]">
          No NIP-07 signer found. Open this page in NCC Browser (built-in signer) or
          install a browser extension.
        </span>
      ) : null}
      {error ? (
        <span className="max-w-[330px] text-[10.5px] text-[color:var(--color-danger)]">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/10 px-3 py-1.5 text-[11.5px] font-semibold text-[color:var(--color-accent)] disabled:opacity-40"
      >
        {busy ? (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-[color:var(--color-accent)]/30 border-t-[color:var(--color-accent)]" />
        ) : (
          <KeyRound className="h-3.5 w-3.5" />
        )}
        {busy ? 'Connecting…' : available === false ? 'Retry signer' : 'Connect signer'}
      </button>
    </div>
  )
}

function Card({
  title,
  hint,
  action,
  children
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[12px] font-semibold text-[#e7e9ef]">{title}</h2>
          {hint ? (
            <p className="mt-0.5 text-[10.5px] leading-relaxed text-[color:var(--color-muted)]">
              {hint}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Field({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
        {label}
      </span>
      {children}
    </label>
  )
}

const inputClass =
  'h-9 w-full rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] px-2.5 text-[11.5px] text-[#dfe3ea] outline-none placeholder:text-[#4d5462] focus:border-[color:var(--color-accent)]/60'

const textareaClass =
  'w-full resize-none rounded-lg border border-[color:var(--color-line)] bg-[#0e1016] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#dfe3ea] outline-none placeholder:text-[#4d5462] focus:border-[color:var(--color-accent)]/60'
