import { AlertTriangle, Clock, Plus, Server } from 'lucide-react'
import { serviceAddress, slugifyService } from '@shared/hosting'
import { CertificateFields } from './CertificateFields'
import { EndpointFields } from './EndpointFields'
import { HostingAlerts } from './HostingAlerts'
import { ReceivedShares } from './ReceivedShares'
import { ServiceCard } from './ServiceCard'
import { ServiceDraftForm } from './ServiceDraftForm'
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
  const shares = useHostingShares(data)
  const form = useHostingDraft({
    feedback: data,
    strictAnchors: data.strictAnchors,
    services: data.state?.services ?? [],
    openShare: shares.openShare,
    resetShares: shares.resetShares,
    dismissPortAlert: data.dismissPortAlert,
    initialDraft,
    onDraftUsed
  })
  const services = useHostingServices({
    feedback: data,
    draftId: form.draft?.id,
    clearDraft: form.cancelDraft
  })

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
          Give a service you run an identity address. Publish it as{' '}
          <span className="font-mono text-[color:var(--color-text)]">ncc://&lt;your npub&gt;/&lt;service&gt;</span>{' '}
          and share it with contacts from your Nostr follow list. Each recipient gets their own
          encrypted link, so relays carry the share tag but not the endpoint.
        </p>
      </div>

      {!identity?.configured ? (
        <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4 text-ui-12 text-[color:var(--color-muted)]">
          Hosting needs an identity to sign the locator.{' '}
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
            <h3 className="text-ui-12 font-semibold text-[color:var(--color-text-strong)]">Your services</h3>
            <p className="text-ui-105 text-[color:var(--color-muted)]">
              {hosted.length ? `${hosted.length} published or ready to publish` : 'Nothing published yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={form.startCreate}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add service
          </button>
        </div>

        {data.error ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 px-3 py-2 text-ui-11 text-[color:var(--color-danger)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {data.error}
          </p>
        ) : null}

        {form.draft ? (
          <ServiceDraftForm
            draft={form.draft}
            patchDraft={form.patchDraft}
            busy={data.busy}
            strictAnchors={data.strictAnchors}
            identity={identity}
            draftAddress={draftAddress}
            copied={data.copied}
            copy={data.copy}
            identityAdmin={identityAdmin}
            endpoint={{
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
              onDiscover: (seed, options) => void form.discover(seed, options),
              onLocalOnlyChange: form.setLocalNetworkOnly,
              onToggleEndpoint: form.toggleEndpoint,
              onMapPort: () => void form.mapPort(),
              onUnmapPort: () => void form.unmapPort(),
              onVerifyMapping: () => void form.verifyMapping()
            }}
            certificate={{
              pins: form.draft.pins,
              info: form.certificateInfo,
              paths: form.certificatePaths,
              busy: form.certificateBusy,
              onImport: () => void form.importCertificate(),
              onGenerate: () => void form.generateCertificate(),
              onClear: form.clearCertificate
            }}
            onSubmit={() => void form.submit()}
            onCancel={form.cancelDraft}
          />
        ) : null}

        {hosted.length === 0 && !form.draft ? (
          <div className="rounded-xl border border-dashed border-[color:var(--color-line)] px-4 py-6 text-center text-ui-12 text-[color:var(--color-muted)]">
            <Server className="mx-auto mb-2 h-5 w-5 text-[color:var(--color-faint)]" />
            Publish a service running on this machine or a home server. The browser holds the identity;
            the locator points at your endpoint.
          </div>
        ) : null}

        {hosted.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            shares={state.shares}
            onions={state.onions}
            npub={identityAdmin.npub}
            identityConfigured={Boolean(identity?.configured)}
            busy={data.busy}
            copied={data.copied}
            copy={data.copy}
            onOpen={openAddress}
            onPublish={(target) => void services.publish(target)}
            onPublishOnion={(target) => void services.publishOnion(target)}
            onRemoveOnion={(target) => void services.removeOnion(target)}
            onEdit={form.startEdit}
            onRemove={(target) => void services.remove(target)}
            sharesApi={shares}
          />
        ))}
      </div>

      <ReceivedShares
        received={state.received}
        onOpen={openAddress}
        onForget={forgetReceived}
      />

      <p className="flex items-start gap-2 text-ui-10 leading-relaxed text-[color:var(--color-faint)]">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        A locator is a signed hint, not a tunnel. The endpoint must be reachable directly or through Tor.
        The browser renews locators while it runs; close it for longer than the lifetime and the address
        stops resolving until you publish again.
      </p>
    </div>
  )
}
