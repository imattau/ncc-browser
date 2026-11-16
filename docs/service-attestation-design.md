# Service attestation control — research and initial design

**Status:** design draft; no publishing behavior implemented

## Goal

Let a signed-in user publish an NCC-02 attestation for the service they are viewing, from a small control at the right end of the address bar. The event is the user's public, signed statement about a service. It must be clear what is being endorsed, what the signature claims, and where it will be published.

## Research findings

- This browser already resolves NCC-02 kind `30059` service records and exposes their `d` service identifier and event id to Site information. NCC-05 provides reachability; the NCC-02 record provides the service identity/trust context.
- The sibling `nostr-community-conventions/ncc-02/README.md` specifies kind `30060` as a parameterized replaceable certificate/transport-key attestation. Required tags are `d=<srv>:<subj>`, `subj`, `srv`, `e` (the exact service-record event id), `std`, `lvl`, `nbf`, and `exp`. Kind `30061` revokes a prior attestation. The convention is marked **Informal / Experimental**.
- The NCC-02 JS helper describes `lvl` values `self`, `verified`, and `hardened`, and orders them as increasing policy thresholds (`self` < `verified` < `hardened`). It does not define concrete evidence criteria for those levels. This feature is about publishing the user's attestation; downstream clients decide whether or how to trust or use it.
- The builder sets `content` to `NCC-02 Attestation` (and revocations to `NCC-02 Revocation`); this design should match that existing wire format.
- Identity is managed as a local key or NIP-46 remote signer. Existing page-facing NIP-07 access deliberately goes through approval UI; a chrome control should use a chrome-owned signing path, show the exact event/claim before signing, and never expose signing to page JavaScript.
- The address bar already reserves trailing controls for Tor, loading, and bookmark actions. A compact rosette/check badge can sit beside the bookmark star, with a popover using the existing chrome overlay pattern.

## Proposed interaction

1. Show a rosette/check button on supported service pages. It is enabled only when a signer is configured and a fresh, valid NCC-02 service record is available. On ordinary HTTPS sites, unanchored NCC pages, error pages, and private/Tor tabs with an ephemeral identity, show a disabled state with a short reason (or hide where no meaningful service identity exists).
2. Clicking opens a popover anchored to the button. It identifies the service by its owner npub and service id, shows the exact endpoint currently viewed, and identifies the NCC-02 record by a shortened event id. State plainly: “This publishes a public attestation signed by [your identity].”
3. Ask the user to choose/confirm the claim level and expiry, using the NCC-02 values and explaining that the event is their signed attestation. Keep any downstream interpretation or trust policy out of this flow. Because the convention leaves evidence criteria open, present the level as the value the user is publishing rather than a browser-verified rating.
4. Before signing, show a final review of the exact tags/claim and the destination relays. Signing uses the active identity (including NIP-46), then publishes through configured writable relays. Report success only when at least one relay acknowledges; distinguish signing success from relay delivery failure.
5. After success, change the icon to “Attested” for this service and expose the event id, expiry, and “Revoke my attestation” action. Revocation would publish kind `30061` referencing that user's own attestation. Avoid claiming that the broader site is trusted based on this one event.

## Event mapping

For a page whose resolved owner is `ownerPubkey`, service id is `serviceId`, and validated current NCC-02 record is `anchor`:

```json
{
  "kind": 30060,
  "tags": [
    ["d", "<serviceId>:<ownerPubkey>"],
    ["subj", "<ownerPubkey>"],
    ["srv", "<serviceId>"],
    ["e", "<anchor.eventId>"],
    ["std", "nostr-service-trust-v0.1"],
    ["lvl", "<explicitly reviewed level>"],
    ["nbf", "<unix seconds>"],
    ["exp", "<unix seconds>"]
  ],
  "content": "NCC-02 Attestation"
}
```

The signer pubkey is the attestor. The subject is the service owner's pubkey, not the URL host or the visiting user's key. The event must target the exact current service-record event; if that record changes before signing, rebuild the review and require the user to review again. The local NCC-02 source provides the event shape and level values. The feature publishes that event; it does not decide how another client should interpret it or whether the signer is trusted there.

## Product and security constraints

- Never silently publish on page load or infer assent from a click on the icon alone; require a review/confirm step.
- Keep this action in trusted browser chrome. Do not route through `window.nostr` or let page content choose the event fields.
- Do not imply browser validation, identity verification, endorsement of all paths/content, or a global trust score.
- Don't publish from private/Tor tabs: the event is durable and public, and this browser's private/Tor signer can be ephemeral. Make the privacy consequence explicit if the product later chooses to support it.
- Prevent duplicate click/publish races. Query for an existing current attestation by the active signer, service id, subject, and anchor event before offering a repeat; allow intentional replacement only after showing what changes.
- A kind 30060 event is addressable, so the `d` value is essential to prevent unrelated attestations replacing each other. A revocation is scoped by the revoked event id.
- Relay success is not proof that clients consume or trust the event. This browser currently has no attestation evaluation policy.

## Decisions before implementation

1. Pick a default `lvl` and expiry, and whether users may edit them. NCC-02's builder defaults to `verified` and 30 days; the UI should make both values reviewable.
2. Decide whether to support only anchored NCC pages in v1 (recommended), or define a separate claim for ordinary HTTPS sites where no NCC-02 service record/event exists.
3. Decide how to display prior attestations and offer revocation; kind 30060/30061 are not currently queried by the browser.

## Suggested first implementation slice

Start with anchored `ncc://` pages only: address-bar control, a review popover, explicit signer approval/confirmation, kind 30060 construction, relay publication, and delivery feedback. Keep trust evaluation and incoming attestation display out of this slice. Add kind 30061 revocation once the browser can reliably retain/find the event the user published.
