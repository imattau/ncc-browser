import { ArrowLeft, Check, Copy, Globe, Lock } from 'lucide-react'
import { useState } from 'react'
import {
  serviceAddress,
  slugifyService,
  validateServiceId,
  type HostedService
} from '@shared/hosting'
import type { IdentityStatus } from '@shared/types'
import { cn } from '../../lib/cn'
import { shortIdentity } from '../../lib/format'
import { checkAddresses } from '../../lib/publish-flow'
import { StepHeading, Stepper } from '../guided/Stepper'
import {
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON
} from '../guided/ui'
import type { CertificateFieldsProps } from './CertificateFields'
import { EndpointFields, type EndpointFieldsProps } from './EndpointFields'
import { ServiceAdvancedFields } from './ServiceAdvancedFields'
import { ServiceIdentityPicker } from './ServiceIdentityPicker'
import { startServiceSetup } from './serviceSetup'
import type { DraftState } from './types'
import { servicePayload } from './useHostingDraft'
import type { HostingIdentityApi } from './useHostingIdentity'

export const SERVICE_STEPS = ['Your app', 'Access', 'Check & publish']

interface ServiceWizardProps {
  draft: DraftState
  patchDraft: (patch: Partial<DraftState>) => void
  services: HostedService[]
  strictAnchors: boolean
  identity: IdentityStatus | null
  identityAdmin: HostingIdentityApi
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
  error: string | null
  endpoint: EndpointFieldsProps
  certificate: CertificateFieldsProps
  onOpenIdentity: () => void
  onCancel: () => void
  /** Set the form aside without losing it. */
  onLater: () => void
  /** The kept form's identity and position, which outlive this screen. */
  draftKey: string
  step: number
  setStep: (step: number) => void
  wantTor: boolean
  setWantTor: (wantTor: boolean) => void
  /** Only kept until the browser closes. */
  memoryOnly: boolean
}

/** A new service in three steps: what it is, who can open it, then check and publish. */
export function ServiceWizard({
  draft,
  patchDraft,
  services,
  strictAnchors,
  identity,
  identityAdmin,
  copied,
  copy,
  error,
  endpoint,
  certificate,
  onOpenIdentity,
  onCancel,
  onLater,
  draftKey,
  step,
  setStep,
  wantTor,
  setWantTor,
  memoryOnly
}: ServiceWizardProps) {
  /** Problems are only pointed out once the user has tried to move on. */
  const [tried, setTried] = useState(false)

  const addresses = checkAddresses(draft.endpoints)
  const serviceId = draft.service.trim() || (draft.title.trim() ? slugifyService(draft.title) : '')
  const idCheck = serviceId ? validateServiceId(serviceId) : null
  const taken = services.find((service) => service.service === serviceId.toLowerCase())
  const idProblem =
    idCheck && !idCheck.ok
      ? idCheck.error
      : taken
        ? `“${taken.title}” already uses this address. Change the name, or the short name under More options.`
        : null
  const address =
    identityAdmin.npub && serviceId ? serviceAddress(identityAdmin.npub, serviceId) : ''

  const appProblem = !draft.title.trim()
    ? 'Give your service a name.'
    : addresses.invalid.length > 0
      ? `This is not an address: ${addresses.invalid.join(', ')}`
      : idProblem
  const publicBlocked = addresses.hasLoopback
  const accessProblem =
    draft.visibility === 'public' && publicBlocked
      ? 'A public service can’t include an address that only works on this computer.'
      : null

  const isPrivate = draft.visibility === 'private'
  const hasOnion = addresses.entries.some(({ url }) => new URL(url).hostname.endsWith('.onion'))
  const offerTor = isPrivate && addresses.hasLoopback && !hasOnion
  const useTor = offerTor && wantTor
  const hasAddress = addresses.entries.length > 0

  const next = (problem: string | null): void => {
    if (problem) return setTried(true)
    setTried(false)
    setStep(step + 1)
  }
  const back = (): void => {
    setTried(false)
    setStep(step - 1)
  }
  const finish = (publish: boolean): void => {
    if (appProblem || accessProblem || !identity?.configured) return
    void startServiceSetup(servicePayload(draft, strictAnchors), {
      tor: publish && useTor,
      publish,
      draftKey
    })
  }

  const problemText = (problem: string | null): React.ReactNode =>
    tried && problem ? (
      <p role="alert" data-wizard-problem className="text-ui-11 text-[color:var(--color-danger)]">
        {problem}
      </p>
    ) : null
  const errorText = error ? (
    <p role="alert" className="text-ui-11 text-[color:var(--color-danger)]">
      {error}
    </p>
  ) : null
  const cancel = (
    <>
      <button type="button" data-wizard-later onClick={onLater} className={QUIET_BUTTON}>
        Finish later
      </button>
      <button type="button" data-wizard-cancel onClick={onCancel} className={QUIET_BUTTON}>
        Cancel
      </button>
    </>
  )

  const choice = (
    value: 'private' | 'public',
    title: string,
    text: string,
    icon: React.ReactNode,
    disabled = false
  ): React.ReactNode => (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-3',
        draft.visibility === value
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10'
          : 'border-[color:var(--color-line)]',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      )}
    >
      <input
        type="radio"
        name="service-visibility"
        value={value}
        checked={draft.visibility === value}
        disabled={disabled}
        onChange={() => patchDraft({ visibility: value })}
        className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
          {icon}
          {title}
        </span>
        <span className={FIELD_HINT}>{text}</span>
      </span>
    </label>
  )

  return (
    <form
      data-service-wizard
      data-wizard-step={step}
      noValidate
      className="space-y-3 rounded-xl border border-[color:var(--color-accent)]/30 bg-[color:var(--color-field)] p-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (step === 0) next(appProblem)
        else if (step === 1) next(accessProblem)
      }}
    >
      <Stepper steps={SERVICE_STEPS} current={step} />

      {!identity?.configured ? (
        <p className="rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-text)]">
          You need a Nostr identity before you can save this.{' '}
          <button
            type="button"
            onClick={onOpenIdentity}
            className="text-[color:var(--color-accent)] underline underline-offset-2"
          >
            Set up an identity
          </button>
        </p>
      ) : null}

      {step === 0 ? (
        <>
          <StepHeading title="Tell us about your app">
            This is for an app or server you already run, such as a photo library or a home
            dashboard. To publish a folder of web pages, use Sites instead.
          </StepHeading>
          <label className={FIELD_LABEL}>
            Name
            <input
              value={draft.title}
              data-service-name
              onChange={(event) => patchDraft({ title: event.target.value })}
              placeholder="Photos"
              className={INPUT}
            />
          </label>
          {address && !idProblem ? (
            <p className="text-ui-105 text-[color:var(--color-muted)]">
              Its address will be{' '}
              <span className="font-mono text-[color:var(--color-text)]">
                ncc://{shortIdentity(identityAdmin.npub)}/{serviceId}
              </span>
            </p>
          ) : null}

          <div>
            <p className="text-ui-11 text-[color:var(--color-text)]">Where is it running?</p>
            <p className="mb-1.5 text-ui-105 leading-relaxed text-[color:var(--color-muted)]">
              Enter the address you use to open it. On this computer that looks like{' '}
              <span className="font-mono">http://127.0.0.1:8080</span>. Not sure? Enter its port
              number under the box and press Find addresses. You can also leave this empty and add
              it later.
            </p>
            <EndpointFields {...endpoint} />
          </div>

          <details
            open={Boolean(draft.service)}
            className="rounded-lg border border-[color:var(--color-line)] p-2.5"
          >
            <summary className="cursor-pointer text-ui-11 text-[color:var(--color-muted)]">
              More options: short name in the address
            </summary>
            <label className={cn(FIELD_LABEL, 'mt-2')}>
              Short name (service id)
              <input
                value={draft.service}
                data-service-id
                onChange={(event) => patchDraft({ service: event.target.value.toLowerCase() })}
                placeholder={draft.title.trim() ? slugifyService(draft.title) : 'photos'}
                className={cn(INPUT, 'font-mono')}
              />
              <span className={FIELD_HINT}>It can’t be changed after saving.</span>
            </label>
          </details>

          {problemText(appProblem)}
          {errorText}
          <div className="flex flex-wrap gap-2">
            <button type="submit" data-wizard-next className={PRIMARY_BUTTON}>
              Continue
            </button>
            {cancel}
          </div>
        </>
      ) : step === 1 ? (
        <>
          <StepHeading title="Who should be able to open it?" />
          <div role="radiogroup" aria-label="Who can open it" className="space-y-2">
            {choice(
              'private',
              'Only me, and people I choose',
              'Where your app runs is encrypted. You pick people after publishing, and each gets their own link.',
              <Lock className="h-3.5 w-3.5" />
            )}
            {choice(
              'public',
              'Anyone with the address',
              publicBlocked
                ? 'Not available: one of your addresses only works on this computer.'
                : 'Where your app runs, including any IP address, can be read by anyone.',
              <Globe className="h-3.5 w-3.5" />,
              publicBlocked && draft.visibility !== 'public'
            )}
          </div>

          <div
            data-service-reach
            className="space-y-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 p-3 text-ui-11 leading-relaxed text-[color:var(--color-muted)]"
          >
            <p className="font-semibold text-[color:var(--color-text-strong)]">
              How others will reach it
            </p>
            {!hasAddress ? (
              <p>You haven’t added an address yet, so it can be saved but not published.</p>
            ) : addresses.onlyLoopback ? (
              <p>The address you entered only works on this computer.</p>
            ) : (
              <p>
                People connect to the addresses you entered. A home network address (such as
                192.168.…) only works for people on the same network.
              </p>
            )}
            {offerTor ? (
              <label className="flex cursor-pointer items-start gap-2 text-ui-11 text-[color:var(--color-text)]">
                <input
                  type="checkbox"
                  data-service-tor
                  checked={wantTor}
                  onChange={(event) => setWantTor(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
                />
                <span>
                  Also create a Tor address
                  <span className={FIELD_HINT}>
                    Lets the people you choose reach it from anywhere, with no router setup. It can
                    be slower. Visitors arrive as local connections, so don’t use it for an admin
                    page that has no login. Keep the browser running.
                  </span>
                </span>
              </label>
            ) : null}
          </div>

          <label className={FIELD_LABEL}>
            Note (optional{isPrivate ? ', shown to people you share with' : ''})
            <input
              value={draft.notes}
              onChange={(event) => patchDraft({ notes: event.target.value })}
              maxLength={280}
              className={INPUT}
            />
          </label>

          <details
            open={Object.keys(draft.pins).length > 0}
            className="rounded-lg border border-[color:var(--color-line)] p-2.5"
          >
            <summary className="cursor-pointer text-ui-11 text-[color:var(--color-muted)]">
              More options: validity, trust record and certificate
            </summary>
            <div className="mt-2.5 space-y-3">
              <ServiceAdvancedFields
                draft={draft}
                patchDraft={patchDraft}
                strictAnchors={strictAnchors}
                certificate={certificate}
              />
            </div>
          </details>

          {problemText(accessProblem)}
          {errorText}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={back} className={SECONDARY_BUTTON}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button type="submit" data-wizard-next className={PRIMARY_BUTTON}>
              Continue
            </button>
            {cancel}
          </div>
        </>
      ) : (
        <>
          <StepHeading title="Check and publish">
            {hasAddress
              ? 'Publishing makes the address work. It doesn’t start your app, so make sure that is running.'
              : 'Without an address for your app, this can only be saved. Add one later with Edit, then publish.'}
          </StepHeading>
          <dl className="space-y-2 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)]/50 p-3 text-ui-11">
            <div>
              <dt className="text-[color:var(--color-muted)]">Name</dt>
              <dd className="text-[color:var(--color-text-strong)]">{draft.title}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted)]">Address</dt>
              <dd className="flex items-start gap-2">
                <span className="min-w-0 break-all font-mono text-[color:var(--color-text)]">
                  {address || 'Set up an identity to see the address'}
                </span>
                {address ? (
                  <button
                    type="button"
                    aria-label="Copy address"
                    onClick={() => void copy('draft-address', address)}
                    className="shrink-0 text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
                  >
                    {copied === 'draft-address' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted)]">Your app runs at</dt>
              <dd className="break-all font-mono text-[color:var(--color-text)]">
                {hasAddress
                  ? addresses.entries.map(({ url }) => <span key={url} className="block">{url}</span>)
                  : 'Not added yet'}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted)]">Who can open it</dt>
              <dd className="text-[color:var(--color-text)]">
                {isPrivate ? 'Only me, and people I choose' : 'Anyone with the address (public)'}
                {useTor ? ' · with a Tor address' : ''}
              </dd>
            </div>
          </dl>

          <ServiceIdentityPicker
            identity={identity}
            identityAdmin={identityAdmin}
            copied={copied}
            copy={copy}
            title="Publishing as"
            description="This identity signs the service, and is part of its address."
          />

          {errorText}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={back} className={SECONDARY_BUTTON}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            {hasAddress ? (
              <>
                <button
                  type="button"
                  data-wizard-publish
                  disabled={!identity?.configured}
                  onClick={() => finish(true)}
                  className={PRIMARY_BUTTON}
                >
                  {isPrivate ? 'Publish' : 'Publish publicly'}
                </button>
                <button
                  type="button"
                  data-wizard-save
                  disabled={!identity?.configured}
                  onClick={() => finish(false)}
                  className={SECONDARY_BUTTON}
                >
                  Save without publishing
                </button>
              </>
            ) : (
              <button
                type="button"
                data-wizard-save
                disabled={!identity?.configured}
                onClick={() => finish(false)}
                className={PRIMARY_BUTTON}
              >
                Save for later
              </button>
            )}
            {cancel}
          </div>
        </>
      )}
      <p data-draft-kept className="text-ui-105 text-[color:var(--color-faint)]">
        {memoryOnly
          ? 'This started from a private or Tor tab, so it isn’t written to disk. It is kept until you close the browser.'
          : 'What you enter is kept on this computer until you save or cancel.'}
      </p>
    </form>
  )
}
