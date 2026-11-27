import { AlertTriangle, Clock, Plus, Server } from 'lucide-react'
import { useEffect } from 'react'
import { serviceAddress, slugifyService } from '@shared/hosting'
import { CertificateFields } from './CertificateFields'
import { EndpointFields } from './EndpointFields'
import { HostingAlerts } from './HostingAlerts'
import { ReceivedShares } from './ReceivedShares'
import { ServiceCard } from './ServiceCard'
import { ServiceDraftForm } from './ServiceDraftForm'
import { dismissServiceSetup, serviceSetup } from './serviceSetup'
import { ServiceSetupProgress } from './ServiceSetupProgress'
import { ServiceWizard } from './ServiceWizard'
import { DraftWarnings, UnfinishedServiceCard } from './UnfinishedServiceCard'
import type { HostingSettingsProps } from './types'
import { useHostingDraft } from './useHostingDraft'
import { useHostingIdentity } from './useHostingIdentity'
import { useHostingServices } from './useHostingServices'
import { useHostingShares } from './useHostingShares'
import { useHostingState } from './useHostingState'

/**
 * Hosted services settings. The data, identity, share and form concerns each live in
 * their own hook; this component only wires them together and lays out the page.
 */
export function HostingSettings({
  identity,
  initialDraft,
  onDraftUsed,
  onOpenIdentity,
  onIdentityChange,
  onClose
}: HostingSettingsProps) {
  const data = useHostingState()
  const identityAdmin = useHostingIdentity({
    identity,
    onIdentityChange,
    setError: data.setError
  })
  const shares = useHostingShares(data, identity?.hexPubkey ?? null)
  const form = useHostingDraft({
    feedback: data,
    strictAnchors: data.strictAnchors,
    state: data.state,
    owner: identity ? (identity.hexPubkey ?? null) : undefined,
    openShare: shares.openShare,
    resetShares: shares.resetShares,
    dismissPortAlert: data.dismissPortAlert,
    initialDraft,
    onDraftUsed
  })
  const services = useHostingServices({
    feedback: data,
    draftId: form.unfinished?.draft.id,
    clearDraft: form.cancelDraft
  })
  const setup = serviceSetup.use()
  const newDraftOpen = Boolean(form.draft && !form.draft.id)

  // "Publish this page" starts something new, so a finished setup gets out of the way.
  useEffect(() => {
    if (initialDraft) dismissServiceSetup()
  }, [initialDraft])

  if (!data.state) return null
  const state = data.state
  const hosted = state.services
  const draftServiceId =
    form.draft?.service.trim() ||
    (form.draft?.title.trim() ? slugifyService(form.draft.title) : '')
  const draftAddress =
    identityAdmin.npub && draftServiceId
      ? serviceAddress(identityAdmin.npub, draftServiceId)
      : ''

  const openAddress = (address: string): void => {
    void window.ncc.navigate(address)
    onClose()
  }

  const startCreate = (): void => {
    dismissServiceSetup()
    form.startCreate()
  }

  const endpointProps = form.draft
    ? {
        draft: form.draft,
        patchDraft: form.patchDraft,
        discovery: form.discovery,
        discoveryBusy: form.discoveryBusy,
        discoveryError: form.discoveryError,
        discoveryPort: form.discoveryPort,
        setDiscoveryPort: form.setDiscoveryPort,
        localOnly: form.localOnly,
        externalChecks: data.externalChecks,
        localEndpoint: form.localEndpoint,
        externalCandidate: form.externalCandidate,
        visibleCandidates: form.visibleCandidates,
        mapping: form.mapping,
        mappingBusy: form.mappingBusy,
        verifyBusy: form.verifyBusy,
        onDiscover: (seed: string, options?: Parameters<typeof form.discover>[1]) =>
          void form.discover(seed, options),
        onLocalOnlyChange: form.setLocalNetworkOnly,
        onToggleEndpoint: form.toggleEndpoint,
        onMapPort: () => void form.mapPort(),
        onUnmapPort: () => void form.unmapPort(),
        onVerifyMapping: () => void form.verifyMapping()
      }
    : null
  const certificateProps = form.draft
    ? {
        pins: form.draft.pins,
        info: form.certificateInfo,
        paths: form.certificatePaths,
        busy: form.certificateBusy,
        onImport: () => void form.importCertificate(),
        onGenerate: () => void form.generateCertificate(),
        onClear: form.clearCertificate
      }
    : null
  /** Adding a service takes the whole panel until it is finished or cancelled. */
  const adding = Boolean(setup) || newDraftOpen

  const forgetReceived = (id: string): void => {
    void window.ncc.hostingForgetReceived(id).then(data.apply)
  }

  return (
    <div className="space-y-5" data-hosting-settings>
      <HostingAlerts
        portAlerts={data.portAlerts}
        networkChanges={data.networkChanges}
        busy={data.busy}
        verifyBusy={form.verifyBusy}
        onRecheckPort={(localPort) => void form.recheckPort(localPort)}
        onDismissPort={data.dismissPortAlert}
        onAcceptNetworkChange={(change, publish) => void data.acceptNetworkChange(change, publish)}
        onDismissNetworkChange={data.dismissNetworkChange}
      />

      <div>
        <h2 className="text-ui-15 font-semibold text-[color:var(--color-text-strong)]">Hosted services</h2>
        <p className="mt-1 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
          Give an app you run, such as a photo library or dashboard, an address that opens in
          Nostr Navigator. Keep it to yourself, or share it with people you follow. You don&apos;t
          need a domain.
        </p>
      </div>

      {!identity?.configured && !adding ? (
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-12 text-[color:var(--color-muted)]">
          Hosting needs a Nostr identity.{' '}
          <button
            type="button"
            onClick={onOpenIdentity}
            className="text-[color:var(--color-accent)] underline-offset-2 hover:underline"
          >
            Set up an identity
          </button>
        </div>
      ) : null}

      <div className="space-y-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
              {adding ? 'Add a service' : 'Your services'}
            </h3>
            {adding ? null : (
              <p className="text-ui-105 text-[color:var(--color-muted)]">
                {hosted.length
                  ? `${hosted.length} service${hosted.length === 1 ? '' : 's'}`
                  : 'None yet'}
              </p>
            )}
          </div>
          {adding ? null : (
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add service
            </button>
          )}
        </div>

        {data.error && !form.draft ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-danger)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {data.error}
          </p>
        ) : null}

        {form.existing.length > 0 ? (
          <p
            role="status"
            data-existing-service
            className="rounded-lg border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-text)]"
          >
            This page’s server is already set up as{' '}
            {form.existing.map((service) => `“${service.title}”`).join(' and ')}. Manage it below
            with Edit or People. Use Add service only if you want a separate one.
          </p>
        ) : null}

        {!setup && form.unfinished?.parked ? (
          <UnfinishedServiceCard
            entry={form.unfinished}
            warnings={form.warnings}
            onContinue={form.resume}
            onDiscard={form.discard}
          />
        ) : null}
        {!setup && form.draft ? <DraftWarnings warnings={form.warnings} /> : null}

        {setup ? (
          <ServiceSetupProgress
            job={setup}
            state={state}
            npub={identityAdmin.npub}
            copied={data.copied}
            copy={data.copy}
            onOpen={openAddress}
            onShare={shares.openShare}
          />
        ) : form.draft && endpointProps && certificateProps ? (
          form.draft.id ? (
            <ServiceDraftForm
              draft={form.draft}
              patchDraft={form.patchDraft}
              busy={data.busy}
              error={data.error}
              strictAnchors={data.strictAnchors}
              identityConfigured={Boolean(identity?.configured)}
              draftAddress={draftAddress}
              copied={data.copied}
              copy={data.copy}
              endpoint={endpointProps}
              certificate={certificateProps}
              onSubmit={() => void form.submit()}
              onCancel={form.discard}
              onLater={form.park}
            />
          ) : (
            <ServiceWizard
              key={form.unfinished!.key}
              draftKey={form.unfinished!.key}
              step={form.unfinished!.step}
              setStep={form.setStep}
              wantTor={form.unfinished!.wantTor}
              setWantTor={form.setWantTor}
              memoryOnly={form.unfinished!.memoryOnly}
              onLater={form.park}
              draft={form.draft}
              patchDraft={form.patchDraft}
              services={hosted}
              strictAnchors={data.strictAnchors}
              identity={identity}
              identityAdmin={identityAdmin}
              copied={data.copied}
              copy={data.copy}
              error={data.error}
              endpoint={endpointProps}
              certificate={certificateProps}
              onOpenIdentity={onOpenIdentity}
              onCancel={form.discard}
            />
          )
        ) : null}

        {hosted.length === 0 && !form.unfinished && !setup ? (
          <div className="rounded-xl border border-dashed border-[color:var(--color-line)] px-4 py-6 text-center text-ui-12 text-[color:var(--color-muted)]">
            <Server className="mx-auto mb-2 h-5 w-5 text-[color:var(--color-faint)]" />
            Press Add service. Three short steps: say where your app is running, choose who can
            open it, then publish.
          </div>
        ) : null}

        {(adding ? [] : hosted).map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            shares={state.shares}
            onions={state.onions}
            https={state.https?.find((plan) => plan.serviceId === service.id)}
            npub={identityAdmin.npub}
            identityConfigured={Boolean(identity?.configured)}
            busy={data.busy}
            copied={data.copied}
            copy={data.copy}
            onOpen={openAddress}
            onPublish={(target) => void services.publish(target)}
            onPublishOnion={(target) => void services.publishOnion(target)}
            onRemoveOnion={(target) => void services.removeOnion(target)}
            onPublishTlsProxy={(target) => void services.publishTlsProxy(target)}
            onRemoveTlsProxy={(target) => void services.removeTlsProxy(target)}
            onEdit={form.startEdit}
            onRemove={(target) => void services.remove(target)}
            sharesApi={shares}
            activity={services.activity?.id === service.id ? services.activity.label : null}
            failure={services.failure?.id === service.id ? services.failure.message : null}
          />
        ))}
      </div>

      {adding ? null : (
        <ReceivedShares
          received={state.received}
          onOpen={openAddress}
          onForget={forgetReceived}
        />
      )}

      <p className="flex items-start gap-2 text-ui-10 leading-relaxed text-[color:var(--color-faint)]">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        The address only tells visitors where your app is, so the app must be running and reachable.
        The browser renews the address while it runs. If it stays closed too long, the address stops
        working until you publish again.
      </p>
    </div>
  )
}
