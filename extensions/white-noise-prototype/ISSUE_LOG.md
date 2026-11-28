# White Noise Companion issue log

Use this file to record issues reported during prototype work. Move entries to
**Fixed** only after the change is built and its behavior has been checked.

## Open / in progress

### White Noise Companion is available in desktop app settings

- **Status:** Bundled in desktop packaging and dev-runtime checked.
- **Change:** The desktop build now includes the current `.nccx` package. The
  Extensions settings page offers **Install White Noise Companion** and stages
  it through the existing extension permission review; the app does not install
  or enable it silently. Private-tab access starts unchecked. The bundled update
  path recognizes an existing local companion package by its manifest name so
  it can replace that install while preserving its extension ID and local
  storage instead of creating a duplicate.
- **Check:** In an isolated `npm run dev` profile, the install action opened the
  permission review and listed the companion's requested permissions. Private
  tabs were unchecked. After approval, the companion appeared as a toolbar
  action, opened its 380 px panel, and had no panel-console errors. Registry
  tests verify the review gate and that upgrading an existing `.nccx` install
  preserves its ID and local storage. `npx electron-vite build`, typecheck,
  lint, and 17 focused registry/migration tests passed. A Linux directory
  package was built with the local Electron distribution and contains
  `resources/extensions/white-noise-companion.nccx`. The packaged app was
  launched with a disposable config profile; its bundled install action opened
  the permission review and again showed private-tab access unchecked. Both
  temporary QA profiles were removed after the checks.

### Message reactions

- **Status:** Kind-7 reaction sending and display implemented; Android
  cross-client verification remains pending.
- **Change:** Added a compact per-message reaction picker and reaction-count
  chips. The companion sends reactions as kind-7 application messages with
  NIP-25 `e`, `p` and `k` references, and aggregates the latest local history
  by emoji and reacting account.
- **Local check (2026-11-29):** In a disposable `npm run dev` profile, opened a
  temporary Note to self chat, chose ❤️ from the picker, and confirmed the
  bubble updated to `❤️ 1` with “Reaction sent.” The extension panel reported
  no renderer errors; it logged only the existing expected fallback warning
  because the temporary identity has no published Blossom server list.
  Focused runtime tests, typecheck, lint, the extension bundle build, and
  `.nccx` validation passed.
- **Next:** Verify received reactions and replies between the companion and a
  supported White Noise build, then implement reaction removal if the protocol
  behavior interoperates.

### Group creation cannot be cancelled

- **Status:** Fixed and runtime checked.
- **Reported:** 2026-11-29
- **Observed:** There is no clear way to cancel or dismiss the group-creation
  flow after it has been opened.
- **Expected:** A visible Cancel or close action returns to the chat list without
  creating a group or changing the active account.
- **Change:** Added a visible Cancel button and Escape-key dismissal. Both are
  disabled while group creation is in flight; cancel resets the form values.
- **Check:** In the isolated dev profile, confirmed both Cancel and Escape hide
  the form without creating a group; the existing Note to self chat remained.

### Contacts are unavailable when starting a chat

- **Status:** Fixed and cross-device runtime checked.
- **Reported:** 2026-11-29
- **Observed:** The companion does not offer a contact list when starting a
  chat. Users can only enter a profile address in the invite flow.
- **Expected:** Discover and select known contacts when creating a chat, with a
  clear path to invite someone by profile address when they are not in contacts.
- **Change:** Added the explicitly permissioned `contacts:read` bridge to NCC's
  cached active-profile contact list, plus a searchable contact picker, refresh
  action, npub entry, existing-chat reuse and direct MLS chat creation. The
  contact's KeyPackage is checked before creating the group, so a missing or
  unavailable invite key does not leave an empty new chat.
- **Check:** In the isolated dev profiles, verified an empty contact list and
  the npub entry; a synthetic nonexistent key showed the missing-KeyPackage
  error without creating a group. Then added a second synthetic QA profile to
  the first profile's public follow list and published its KeyPackage. The
  contact appeared by profile name, the direct chat invite arrived on three
  relays, the second profile joined (2 members, epoch 1), and subsequent
  messages from each account appeared in the other account's open chat. The
  initial note sent before the invite was not available to the joining member.

### Same-account devices need separate group membership

- **Status:** Open; Marmot multi-device linking and chat synchronization are
  not implemented by the pinned `@internet-privacy/marmot-ts` 0.9.0 package.
- **Reported:** 2026-11-29
- **Observed:** The same npub on another device appears as a separate MLS
  member and must be invited separately.
- **Cause:** Each installation has its own KeyPackage, MLS state and private
  keys. Signing in with the same npub therefore does not restore the other
  installation's groups or make it the same MLS client; it remains the same
  Nostr identity. The current companion package exposes no device-pairing,
  device-roster or account-sync API.
- **Current limit:** The normal invite path cannot add another device for an
  pubkey that is already in the group. The pinned library's
  `evaluateKeyPackageForGroup()` rejects a KeyPackage when the group's member
  pubkey set already contains its author. So same-account device enrollment
  is not currently available through the companion; ordinary invites work for
  a different account only.
- **UI guard:** The companion rejects an attempt to start a chat with its own
  account or invite its own account into a group, with a message explaining
  that linked-device support is unavailable.
- **Live check (2026-11-29):** In a disposable NCC profile, created a Note to
  self group and submitted the connected account's own npub from the in-chat
  Invite member action. The companion showed the linked-device message before
  querying or publishing a KeyPackage invite; the group remained unchanged.
  No real profile or device was used.
- **Compatibility research (2026-11-29):** The current Marmot protocol
  repository has an adopted `0x800d` account-devices component that permits
  same-account membership operations when a group requires it. The companion's
  Marmot compatibility patch recognizes and advertises the data-less `0x800d`
  marker and validates its presence in Welcomes and group state; that is only
  protocol-marker compatibility, not device enrollment. The installed
  `@internet-privacy/marmot-ts` 0.9.0 implementation still has
  `evaluateKeyPackageForGroup()` reject a KeyPackage whose Nostr account is
  already a member, and the companion has no API for the required authorized
  same-account add. The library's commit authorization also permits a
  non-admin only to self-update or self-remove; it does not authorize the
  `0x800d` same-account commit shape. Therefore, on a group that requires
  `0x800d`, accepting the data-less marker does not guarantee that this client
  can process or produce device-membership commits. Upstream's device-pairing,
  hidden device-group/roster and account-sync features (including history
  delivery) are still marked draft. White Noise's compatibility guide also
  says linked-device support is still in development and importing the same
  identity does not sync history or encryption state.
- **Release check (2026-11-29):** The upstream `marmot-ts` GitHub releases page
  still marks v0.9.0 as latest. This repository is also pinned to
  `@internet-privacy/marmot-ts` 0.9.0. The newer account-device and pairing
  protocol documents remain drafts; there is no newer published Marmot TS
  release to deploy to the emulator for linked-device restoration.
- **White Noise release check (2026-11-29):** White Noise's current Android
  release remains `android-v2026.11.17` (MarmotKit 0.17.0). Its compatibility
  guide says linked devices are still in development and a second installation
  does not sync history. Device-linking work visible in the upstream Android
  source is therefore not evidence that the released emulator app can perform
  the flow. Re-test against a release that includes the device-pairing and
  history-delivery protocol before claiming companion interoperability.
- **Next:** Add multi-device support only with a compatible implementation of
  same-account authorization plus the device-pairing/device-group flow. Do not
  copy MLS state or private KeyPackage material between devices.

### No plain chat interface

- **Status:** Direct-chat flow runtime checked; plain unencrypted chat is not
  part of Marmot.
- **Reported:** 2026-11-29
- **Observed:** A one-to-one chat can now be started directly from a contact,
  without asking the user to create a group and then invite them. It remains an
  MLS group under Marmot; the protocol has no unencrypted/plain chat mode.
- **Expected:** Provide a familiar one-to-one chat flow while keeping MLS
  encryption visible in the UI.
- **Duplicate prevention:** Starting a one-to-one chat now checks Marmot's
  loaded local groups for the exact two-member account pair before querying a
  fresh invite key or creating a group. This avoids duplicate direct groups
  after a list refresh or repeated start-chat action. Concurrent starts for
  the same pair are coalesced so they cannot create two groups at once; it
  does not transfer a conversation from another device.
- **Check:** Started a one-to-one MLS chat from a contact in the isolated
  profiles and confirmed both sides could exchange messages. Account B was
  then restarted with the same temporary profile; it reconnected to the signer,
  restored the two-member group, and reloaded both message histories.
  Regression coverage verifies only the exact two-member pair is reused,
  larger groups are not mistaken for direct chats, and concurrent requests
  share one group creation. The focused runtime suite passed (17 tests), the
  extension bundle built, app typecheck and lint passed. Packaged companion
  version 0.1.3 and validated the extracted package with the extension SDK.

### Account and member profile names and photos

- **Status:** Fixed and runtime checked.
- **Reported:** 2026-11-28
- **Observed:** The companion showed “Connected account,” a placeholder avatar,
  and abbreviated public keys for chat authors.
- **Change:** Added a permissioned `nostr.getProfile` extension API. It queries
  kind-0 metadata over the companion's approved relays, checks both the
  canonical event hash and signature, validates
  HTTPS picture URLs, rejects redirects, and returns only bounded image data
  (up to 512 KB). The companion uses names/photos for its account header,
  message authors, and unnamed group member labels. The account header now
  renders cached profile data after its asynchronous lookup completes and
  clears stale avatar styling when the active account changes.
- **Check:** In the isolated temp profile, after a full dev-browser restart the
  account header showed `NCC White Noise Temp QA` with its profile image, and
  retained both after the follow-up render. The self-chat author also showed
  the same name. TypeScript check, extension validation, and five focused
  profile tests passed. Tests cover newest-event selection, altered
  content/signatures, malformed metadata, bounded HTTPS image conversion,
  unsupported MIME types, oversized declared images, and image-host failure.

### Discovering groups created before the companion

- **Status:** Marmot local-state limitation; empty-state explanation corrected,
  packaged and runtime checked.
- **Observed:** Groups created on another device do not appear automatically
  after connecting the companion.
- **Cause:** Marmot's group registry enumerates local stored MLS group state;
  relay queries do not provide the secrets and complete state required to
  reconstruct an existing MLS group on a new device. This is not caused by
  different KeyPackages: each device's KeyPackage is its invitation credential,
  while a Welcome initializes that device's independent MLS group state.
- **Diagnostic distinction:** If a group was created or joined in this same
  NCC profile, it should be returned by `groups.loadAll()` from the companion's
  per-account local group-state store. If that same-profile group is missing,
  investigate the extension profile/storage migration or load errors; creating
  a fresh KeyPackage will not recover it. NCC storage now reports corrupt or
  invalid storage files and leaves them untouched instead of treating them as
  empty. Groups present only on another device require linked-device support
  and cannot be discovered from relay history.
- **Protocol-age distinction:** A stale or incompatible KeyPackage can prevent
  a new invite or Welcome from being accepted, but it does not determine which
  already-stored groups `loadAll()` discovers. Separately, Marmot TS 0.9.0's
  changelog documents protocol compatibility limits for legacy groups (for
  example, legacy account-identity proofs and existing dictionary-first groups);
  those can affect group traffic or cause a split without explaining an absent
  group in a fresh device's local registry.
- **Same-profile restart check (2026-11-29):** In the disposable dev profile,
  created a one-member Note to self group and its encrypted note, stopped and
  relaunched `npm run dev` against that same profile, then reconnected the same
  temporary signer. The group returned at epoch 0 and the note rendered from
  history. This confirms local restart persistence only; it does not test
  restoration from another device.
- **Storage regression coverage:** Extracted the Chrome key-value adapter used
  by Marmot's MLS, rewind, invite, ingest, and history stores into
  `extension-store.js`. Focused tests confirm nested BigInt, binary, Map and Set
  values round-trip and that clearing one account's group namespace leaves
  another account's group state intact. The targeted runtime suite passed
  (14 tests), the extension bundle built, and a `.nccx` package validated.
  After the refactor, relaunched the dev app with the rebuilt extension against
  the same temp profile and confirmed the pre-refactor group and encrypted note
  still loaded.
- **Legacy migration gap (2026-11-29):** The pre-account namespace migration
  copied MLS groups and message history but omitted Marmot rewind state. Added
  rewind-state migration alongside the other Marmot stores. Regression coverage
  verifies the old rewind entries move into the matching account namespace,
  unrelated account data stays excluded, and a recorded different signer
  blocks migration. The focused migration tests passed and the updated 0.1.3
  `.nccx` package validates. This fixes local legacy-profile migration only;
  it does not restore state that exists only on another device.

- **Current limit:** There is no supported recovery path for this companion to
  join a group where the same account is already a member on another device.
  The ordinary invite eligibility check rejects a second KeyPackage for that
  pubkey. A normal invite can add an account that is not already a member, but
  it cannot restore same-account device membership or history.
- **UI change:** Removed the suggestion to ask a group member to invite the
  same account. The empty state now explains that chat/group state is local to
  each device and that linked-device restoration is not supported yet.
- **Check:** Confirmed the companion uses Marmot's local `loadAll()` registry
  and cross-checked the duplicate-member rejection in
  `evaluateKeyPackageForGroup()`. A new temporary member did not receive a note
  sent before its Welcome; messages sent after joining were delivered and
  persisted locally. In a disposable NCC profile, installed the current
  companion through `NCC_EXTENSION_DIR`, connected the existing QA signer with
  extension chat storage cleared, and confirmed the empty state explains that
  linked-device restoration is still in development. It no longer suggests
  asking a member to invite the same account. The checked-in `.nccx` had been
  stale at version 0.1.0, so it was rebuilt as 0.1.1 from the current source.
  The original disposable chat storage was restored after the check.
- **Reactive group-list updates (2026-11-29):** Replaced the companion's list
  of manually subscribed group lifecycle event names with Marmot TS 0.9.0's
  `groups.watch({ includeStateChanges: true })` API. The watcher refreshes the
  visible local group list and is aborted when the signer/account disconnects.
  The `loadAll()` hydration step still runs before watching. This helps the
  companion reflect local groups and group snapshot changes during the current
  session; it does not discover remote-only groups or restore another device's
  MLS state. Focused watcher tests, the runtime suite, typecheck, lint, and
  extension bundle build passed; the packaged `.nccx` validates.

### Local extension storage quota limits long-term chat state

- **Status:** Mitigated with a bounded, reviewed larger-storage permission;
  scalable storage remains a follow-up for very large histories.
- **Cause:** NCC's default `storage.local` quota is 10 MB per extension, while
  Marmot's MLS group state, rewind state and message history are all durable
  companion data. A quota error could eventually stop new state from being
  saved and break chat use or restart recovery.
- **Change:** Added the optional `storage:large` permission. It raises only
  `storage.local` to a hard 128 MB ceiling; other extension storage areas keep
  their existing quotas. The permission is shown in install review, and updates
  mark it as a newly added grant. The companion requests it in version 0.1.2.
- **Check:** Storage unit tests verify the default 10 MB ceiling, the 128 MB
  permission cap, and unchanged `storage.sync` limits. An extension-service API
  test verifies the manifest permission actually selects the larger local
  quota. Install-review tests verify the permission description and added-grant
  flag. 29 targeted tests passed; the app typecheck passed; the 0.1.2 companion
  package validated successfully.
- **Current limit:** The backing store rewrites a JSON file on each change, so
  the permission has a 128 MB ceiling. A database or per-key storage backend is
  needed before raising that cap further.

### Received image and video presentation

- **Status:** Fixed and runtime checked.
- **Observed:** Attachments were only shown as download links, with no inline
  video player.
- **Change:** Decrypted image/video attachments load automatically as their
  messages approach the visible chat area; other files remain on demand. Images
  render inline, videos use a controlled player, and save links are provided.
  A 48 MB in-memory LRU cache preserves decrypted media through chat refreshes
  without storing plaintext files in extension storage. The extension-page CSP
  now explicitly allows `blob:` media URLs for decrypted video previews.
  The cache is cleared on account change.
- **Check:** In the isolated temp profile, sent a PNG and MP4 through the chat's
  **Photos & videos** action, restarted the dev browser, downloaded and
  decrypted both, and verified the image rendered inline and the video rendered
  in its player. The extension console had no CSP or renderer errors after the
  CSP fix. Typecheck, lint, and the focused extension/automation/signer suite
  passed.

### Partial relay publication is presented as failure

- **Status:** Fixed and live verified in the isolated temporary profile.
- **Change:** KeyPackage publication feedback keeps success when one or more
  relays acknowledge and reports unavailable relays as a warning. It remains an
  error only when no relay acknowledges. Warning text follows the light/dark
  theme colors.
- **Check:** In the isolated temporary profile, the companion remained connected
  while publishing an invite key with `relay.damus.io` failing its authenticated
  connection retry. The other two selected relays acknowledged publication; the
  UI reported the invite available on 2 relays, incoming invites on 2 relays,
  and one unavailable relay as a warning. The operation stayed successful.

### Android group details parity

- **Status:** Core metadata and member controls implemented and runtime checked.
- **Change:** Added a Group details action showing group name, description,
  retention timer, relay list, member count, member public keys, and admin roles
  from the Marmot group snapshot. Admins can edit name, description and the
  supported retention timer, and remove another member after confirmation.
  Marmot `proposeRemoveUser` proposes removing all MLS leaves for that Nostr
  user, and the client verifies removal after commit.
- **Check:** The dev companion displayed details for the two-member
  `Interop Primal Ditto` group. Removing the Android member from a disposable
  two-member group advanced the epoch from 1 to 2 and left only its admin. A
  fresh one-member group was created with a description and one-hour retention;
  editing it to a different description and one-day retention committed at
  epoch 2 and showed those values in the snapshot and details view. After
  setting a two-second timer on that one-member test group, a new message left
  the transcript at expiry while its encrypted rumor remained in Marmot history.
  The test group was deleted from the temporary profile afterward.
- **Limit:** Expiration hides messages in this device's view but does not
  securely erase cached or saved copies. Admin handoff before leaving is
  implemented and runtime checked in the group-management section below.

### Group photo upload server compatibility

- **Status:** Multi-server upload and download fallback implemented and runtime
  checked against Ditto, Divine and Primal in an isolated desktop profile;
  compatibility remains host-specific.
- **Change:** Admins can choose or remove a group photo in group settings. The
  companion accepts JPEG, PNG and WebP up to 5 MB, calls Marmot's encrypted
  group-image APIs, uses the account's Blossom server list, and shows available
  photos in the chat list and editor.
- **Check:** Added a dedicated `blossom:group-image` permission and a narrow
  main-process HTTPS bridge that bounds response bytes, rejects redirects, checks
  upload hashes and signed Blossom authorization, and limits requests to the
  extension's declared hosts and Marmot's upload/download paths. The pinned
  Marmot image code was adapted to upload the same ciphertext to every
  configured endpoint and accept the MLS update if at least one endpoint
  validates the upload. Reads try authorized endpoints in order and stop after
  the first successful decryption. In an isolated dev user-data profile with a
  temporary identity, uploaded a tiny PNG through `blossom.ditto.pub`, committed
  it to the one-member QA group's MLS state, and read it back into the chat-list
  avatar. A redundancy pass with Ditto and Primal configured attempted both
  uploads concurrently: Ditto returned 201 and Primal returned HTTP 415 for
  Marmot's opaque `application/octet-stream` payload; the MLS update succeeded.
  Then, with Ditto and Divine configured, both accepted the same encrypted
  image hash (Ditto returned HTTP 201 and Divine returned HTTP 200) before the
  MLS update committed. For download fallback, Primal was ordered before Ditto:
  Primal returned 404, then Ditto returned 200 and the image decrypted
  successfully. These checks confirm concurrent redundant uploads, fallback
  after an individual upload failure, and stop-after-success download behavior.
  Typecheck, extension build and `git diff --check` passed.
- **Safety note:** The prior real-profile run was accidental and is not counted
  as an approved isolated QA result. Per the user's instruction, no further
  work has been performed on the real profile or device; current results are
  exclusively from a temporary identity and user-data directory.

### Group and chat management parity

- **Status:** Group actions and core chat-list controls implemented; local
  folders now cover the remaining Android chat-list action identified so far.
- **Compared:** White Noise Android includes local chat actions for archive,
  pin, mute, read state and manual ordering, plus folders and rich group
  settings. Marmot TypeScript supports group metadata updates and leave, while
  archive, pin, mute and order are per-account companion state.
- **Change:** Added group rename and leave through Marmot, local per-account
  archive state, an Archived list view, and group options from both the chat
  list context menu and conversation header. Added pin/unpin ordering, move
  up/down, local mute preference, and mark unread/read; incoming messages mark
  inactive chats unread and opening a chat clears unread. Added group name,
  description and disappearing-message configuration at creation and from
  group details. Added per-profile chat folders with create, rename, delete,
  assignment, and folder filtering. Added opt-in generic desktop alerts for new
  messages; alerts omit chat names and content, skip the open conversation, and
  respect the per-chat mute preference. Expired messages are hidden from the
  companion transcript and chat preview; Marmot local history remains cached
  until the user clears it. Relay settings commit shared group relay metadata
  only when the active account is an admin; the UI explains why other groups
  retain their admin-controlled relay list.
- **Limit:** Archive, pin, mute preference, unread, ordering and folders are
  local to this NCC profile. Group-photo runtime interop is tracked above.
- **Check:** In the dev browser, archive removed a diagnostic group from the
  active list, it appeared in Archived, and restore returned it to Chats.
  Rename committed to the diagnostic group and restored its original name.
  Clear history removed message bubbles and displayed the empty state. Local
  delete removed a diagnostic chat from the list and closed its conversation.
  Pin/unpin, mute/unmute preference, mark unread/open-to-read, and move-up then
  move-down were exercised on `NCC_Interop_2026-11-28`; state changed as expected
  and the original preferences and order were restored.
  Leave was attempted on a two-member diagnostic group but Marmot rejected it
  because the current member is an active admin. The group remained listed.
  An explicit admin handoff flow was added and verified on the disposable
  NIP42 Result Trace group. It transferred admin rights to the other member,
  received leave acknowledgement, and removed the group from the local list.
  In the isolated temporary profile, created “QA Folder,” assigned the
  disposable QA chat, filtered to the folder, restarted the dev browser, then
  selected the folder again and confirmed its chat still appeared. Renamed the
  folder and confirmed the assignment stayed intact; deleting it returned the
  chat to All without deleting the chat. In the isolated profile, the
  notification option was off by default, persisted after restart, and was
  turned off again after verification. A synthetic incoming message produced
  one generic alert in an unmuted chat; a second produced no alert after mute.
- **Relay-list regression check (2026-11-29):** Focused tests confirmed changed
  relay metadata is planned only for groups administered by the active account,
  unchanged groups are ignored, and unnamed groups receive a stable fallback
  label for the permission explanation. The runtime suite passed (21 tests),
  typecheck and lint passed, the extension bundle built, and the regenerated
  0.1.3 `.nccx` validated with the SDK.
- **Next:** Continue testing remaining companion features and cross-device
  interoperability.

### 1. Cross-device Marmot compatibility

- **Status:** Core text and media interoperability verified; protocol edge cases remain.
- **Reported:** 2026-11-28
- **Observed:** The installed White Noise Android `2026.11.17-dev-debug`
  profile created `NCC_Interop_2026-11-28`, invited the companion, and accepted
  the companion's MLS text message. The companion received the Android Welcome,
  joined the two-member group, and received an Android reply after reconnecting.
  The group and both messages were still present after restarting the dev
  browser.
- **Relay fallback:** User-configured relays stay primary. The companion adds
  White Noise EU and US hosted relays after them in Marmot's group connection
  fallback set. Key-package and kind-10050 inbox relay lists continue to publish
  only the configured relay list. Defaults use Damus, Primal, and Ditto as
  primary relays. White Noise EU/US are appended only to Marmot's group
  connection fallback set. `nos.lol` is not a default, but remains permitted
  when explicitly configured.
- **Change:** The companion publishes the account's kind-10050 inbox relay list
  with the configured relay set when publishing an invite key.
  It listens for and decrypts incoming kind-1059 Welcome gifts, shows a pending
  invitation with preview, and joins or dismisses it. Relay writes and reads
  answer NIP-42 AUTH challenges using the active NCC signer. The compatibility
  patch accepts raw MDK/0.8 incoming KeyPackages, publishes framed KeyPackages,
  and recognizes Marmot `0x800d` as a data-less required component without
  enabling it by default in groups the companion creates. Groups and history
  reload from local extension storage after restart. Invite selection now
  validates published package slots newest-first and falls back to an older
  current package when a newer slot is expired or otherwise unusable. Direct
  chat still checks package usability before creating a group.
- **KeyPackage fallback check (2026-11-29):** A focused regression test supplies
  a duplicated expired newest slot followed by a current slot. The companion
  skips the unusable event and chooses the newest valid package before creating
  a direct-chat group. When all available slots are expired, it gives a clear
  refresh-package message. The focused runtime suite passed (19 tests), the
  extension bundle built, and the 0.1.3 `.nccx` validated with the extension
  SDK. This checks candidate selection; live Android interop still depends on
  the recipient publishing at least one compatible current KeyPackage.
- **Additional interop check:** With White Noise Android online, the companion
  created `NCC_Online_Invite_2026-11-28` and invited the Android profile. Android
  received the Welcome, displayed the group preview, and accepted it. Android
  saw a companion message, and the companion received an Android reply. The
  companion panel was closed and reopened; the group (2 members, epoch 2) and
  both reply histories loaded from extension storage.
- **Latest isolated interop check:** A fresh API 37 emulator with White Noise
  `2026.11.17-dev-debug` accepted the temporary companion group's invite and
  sent `Android test prompt`. The companion received it and sent a q-only
  reply. After closing and restarting `npm run dev` against the same temporary
  profile, the companion reconnected without another signer prompt, restored
  the two-member group, and loaded both messages and the reply context from
  history. Android showed `Replying to You: Android test prompt` and no
  `Event not found` preview. This run used the isolated AVD on port 5560 and
  temporary identities/data only.
- **Temp desktop contact-chat interop (2026-11-29):** Two separate dev
  instances used only temporary QA profiles and signers. The new contacts
  permission loaded the second profile from the first profile's kind-3 list.
  The companion discovered the contact, sent the KeyPackage invite, received
  the Welcome on the second profile, and joined the two-member group. Each side
  then sent a message that rendered in the other's open conversation. The
  second profile correctly had no access to the note sent before it joined.
  After closing and relaunching browser B with the same temp profile, the
  companion reconnected to the signer automatically, restored the group, and
  loaded both exchanged messages. Both renderer consoles had zero errors.
- **Two-profile direct-chat and restart check (2026-11-29):** Two separate
  `npm run dev` instances used disposable profile A and B, separate temporary
  identities and automation ports. B published its invite KeyPackage to two
  relays; `relay.damus.io` failed, and the companion correctly kept the partial
  success. A entered B's temporary npub in **New chat**, created the direct MLS
  group and sent the Welcome. B received the invitation and joined at epoch 1.
  A's pre-join note was not available to B; A's post-join test message rendered
  in B's chat list and transcript. Repeating **New chat** with the same npub
  reopened the existing conversation; both profiles still showed one group row
  and B had no second invitation. A was restarted with the same temporary
  user-data directory and identity; it reconnected, restored the group and
  transcript, and received a reply sent from B after the restart. These checks
  used separate Nostr accounts and do not test same-account linked-device
  restoration. Both dev processes and temporary profiles were cleaned up after
  verification.
- **Delayed Welcome check:** A fresh temporary recipient published a KeyPackage
  and kind-10050 inbox relay list, then was switched offline. The inviter sent
  a Welcome to a disposable group. After switching back, the recipient saw a
  joinable invitation within the first 7-second check and joined; its snapshot
  showed two members. It sent an MLS message that the inviter received. The
  inviter then sent a reply while the recipient was offline; after switching
  back, the recipient loaded that reply from the relay. Both test groups and
  the temporary identity were removed afterward.
- **Relay propagation check:** On a separate disposable group, changing the
  selected relays from Damus/Primal/Ditto to Damus/Ditto updated the group's
  MLS metadata to exactly those two relays. Restoring the three-relay list
  propagated the restored list to the group. The local test group was deleted.
- **Live update fix:** An Android reply updated the chat-list preview but did
  not render in an already-open conversation. The event listener compared
  binary group IDs by object identity and was reattached on each group refresh.
  It now compares stable group IDs and registers listeners once per group
  instance. A new Android reply rendered in the open conversation without
  reopening it. Chat previews now select kind-9 chat messages so Marmot kind-447
  push-control payloads do not appear as message text.
- **Check:** A fresh framed KeyPackage advertising `0x800d` was acknowledged on
  four relays. Android validated it; after the companion published its inbox
  relay list, Android's group-invite trace ended with `projection=success` and
  `owner=success`. The companion received the Welcome, joined the group, and
  displayed both participants. “Interop test from NCC companion” appeared on
  Android. “Interop reply from Android reply from Andro” appeared in companion
  history after a fresh dev-browser restart, confirming authenticated reads on
  the White Noise EU/US relays. The app's kind-446 push payload also appeared as
  raw JSON in chat history; the renderer now filters non-chat application
  messages from the conversation transcript.
- **Next:** Continue protocol edge-case coverage across additional White Noise
  releases and group-management operations.

## Fixed

### Android reply reference showed an unresolved event preview

- **Reported:** 2026-11-28
- **Observed:** The companion's NIP-C7 reply displayed its quote correctly in
  White Noise Android, plus a separate preview for the `nostr:nevent` reference
  that said the event could not be found. The Android reply in the reverse
  direction rendered its quote correctly in the companion.
- **Protocol check:** NIP-C7's prose defines a reply by its `q` tag; its example
  also puts a `nostr:nevent` in content. The referenced kind-9 rumor is carried
  inside MLS and is not independently retrievable as a public relay event, so
  that inline reference can trigger an unresolvable public link preview.
- **Change:** Replies now keep the single NIP-C7 `q` tag and plain reply text,
  omitting the inline event reference that caused the preview. The companion
  still renders a contextual quote from the `q` tag and loaded history.
- **Check:** A bundled-runtime check confirmed a reply is kind 9, contains the
  reply text, and has one `q` tag with the correct id and author and no public
  relay hint. On a fresh isolated Android API 37 emulator with White Noise
  `2026.11.17-dev-debug`, accepted a companion-created group invite, sent an
  Android message, then replied from the companion. Android displayed the
  contextual quote `Replying to You: Android test prompt` and the reply text
  `q-only reply interop check`; it showed no unresolved `Event not found`
  preview. After a full restart, the companion reconnected and restored the
  two-member group and both messages. Both apps used temporary identities and
  data directories.

### Android in-chat contact cards and polls

- **Status:** Implemented and cross-device checked.
- **Compared:** White Noise Android's composer menu shares contact cards and
  creates single- or multiple-choice polls. Marmot accepts arbitrary serialized
  application rumors, so these app-level Nostr events can travel inside the MLS
  group without a Marmot library patch.
- **Change:** Added Share contact to the in-composer plus menu. It sends the
  Android-compatible kind-9 `nostr:npub…` card with its matching `p` tag and
  renders received cards with a Copy npub action. Added poll creation for 2–10
  distinct options, single/multiple choice, kind-1068 display and kind-1018
  voting. Poll cards tally each member's latest vote, support changing a single
  choice, and allow multiple-choice toggling while keeping at least one choice.
- **Check:** A contact shared from Android appeared in the companion with its
  npub; a companion-shared contact appeared in Android as a profile card with
  **View profile**. An Android-created kind-1068 poll rendered in the companion.
  A companion-created poll rendered in Android; voting in Android updated the
  companion's live tally to one vote. A companion-created multiple-choice poll
  also rendered in Android; selecting both options produced one vote for each,
  and the companion showed both selections under one voter. After restarting
  the dev browser, the contact cards, poll and vote tally loaded again from
  saved history. The companion hides vote events as standalone chat messages
  and folds them into the poll results.
- **Limit:** Device contacts, camera, location, stickers, dictation and
  translation depend on Android-only services and are not exposed by this
  desktop extension API. Contact sharing currently accepts an npub or hex
  public key.

### NIP-C7 text replies

- **Status:** Text and attachment replies implemented; both verified with White
  Noise Android.
- **Change:** Replies are kind-9 rumors with one `q` tag. The panel previews
  the reply target, supports cancelling, and renders a contextual quote when
  the parent is in loaded history. Media replies keep the same `q` tag alongside
  their encrypted `imeta` attachment tags.
- **Check:** Android displayed the companion reply in the expected quote
  context. An Android reply to a companion message rendered with its matching
  quote in the companion. The q-only content change was confirmed on Android in
  the cross-device issue above. An encrypted PNG reply also rendered on Android
  with the expected quote and caption; after restarting the dev browser, the
  companion restored and decrypted the media reply from history.

### 3. Drag-resize the companion panel

- **Status:** Implemented and runtime checked.
- **Reported:** 2026-11-28
- **Expected:** Drag the panel's left edge to resize it. Width should not be a
  slider in the settings area.
- **Change:** Added a keyboard-accessible left-edge resize handle backed by
  `ncc.runtime.setPanelWidth`; the BrowserWindow clamps widths to 280–600 px.
  No width slider is present in companion settings.
- **Check:** A real pointer drag changed the panel from 380 to 410 px. ArrowLeft
  changed it to 400 px. Restored the width to 380 px after both checks.

### 4. Multiple account profiles

- **Status:** Implemented and runtime verified
- **Reported:** 2026-11-28
- **Expected:** Integrate White Noise's multiple accounts with NCC Browser's
  profile/account model cleanly, including clear account switching and isolated
  Marmot state per account.
- **Change:** The companion reconnects using the active NCC signer and watches
  its public key while open. When NCC's active profile changes, it tears down
  the old listeners and reloads that profile's chats from its own account
  namespace. It does not request or use the privileged profile-selection API;
  switching remains an NCC Browser action. The Reload profile helper explains
  this when the active profile has not changed.
- **Check:** In the local dev profile, generated a temporary second NCC
  identity. The companion switched to it and showed zero chats; switching back
  restored the original profile's 13 chats. Removed the temporary identity.
  Closed and reopened the panel; the same original account and all 13 chats
  returned without another signer connection.

### 6. Search results showed an invite-key action

- **Status:** Fixed and runtime checked
- **Reported:** 2026-11-28
- **Observed:** After typing a few characters in Search chats, an empty result
  state showed **Create invite key package**, which is unrelated to searching.
- **Change:** Search misses show a search-specific empty state without a
  connection or invite-key action. See `panel.js` (`renderGroups`).
- **Check:** In the running dev panel, a non-matching query showed the
  search-specific empty state and no buttons. A matching query returned the
  expected chat row.

### Chat file and media sharing

- **Status:** Implemented and cross-device verified, including after restart.
- **Reported:** 2026-11-28
- **Expected:** The in-composer plus menu should offer file/media sharing, and
  supported files or images pasted into the composer should be staged as
  attachments. Sending and receiving must use Marmot encrypted media.
- **Change:** Connected marmot-ts 0.9.0's encrypted-media policy, Blossom
  transport, media preparation/download, and `imeta` parsing. New groups use
  the account's published kind-10063 Blossom server list, falling back to
  `https://blossom.ditto.pub` then `https://blossom.primal.net`; admins can enable media in older groups. Added
  explicit host permissions for the tested White Noise Blossom/CDN endpoints.
  The chat plus menu opens a multi-file picker, clipboard image/file pastes
  stage files beside the composer, and received attachments download on demand
  and decrypt before display/save. A durable per-account Marmot `rewindStore`
  retains authenticated source epochs across restarts. Limits are 25 MB per
  file, 10 files and 100 MB per message.
  Chat uploads now attempt every configured Blossom endpoint and attach all
  successful locators to the same encrypted rumor; downloads try each locator
  and stop at the first copy that decrypts. If one upload host fails, the
  remaining successful copies are still used.
- **Clipboard check:** Pasted an image file through the composer event path; the
  default paste was prevented and the file appeared in the attachment tray
  without being sent.
- **Check:** Sent a standards-valid PNG from the companion into the Android
  `NCC_Interop_2026-11-28` group; Android downloaded and rendered the image.
  Sent a PNG from Android; the companion downloaded the encrypted blob from
  `cdn.divine.video`, decrypted it, and rendered a 32×32 image. Repeated with
  a fresh Android image after enabling the durable rewind store, restarted the
  dev browser, then verified the authenticated source epoch was restored and
  the companion again decrypted and rendered the 32×32 image. Upload used
  `blossom.ditto.pub` after the first advertised endpoint was unreachable. One
  older test attachment received before rewind persistence was enabled remains
  undecryptable in this disposable profile; new incoming attachments persist
  correctly. A mocked runtime check configured three upload endpoints, forced
  the second to fail, verified both successful locators were serialized into
  the rumor, then forced the first download copy to fail decryption and verified
  the second copy decrypted successfully. A live run through Marmot's chat
  media preparation and Blossom transport uploaded the same random ciphertext
  to `blossom.ditto.pub` and `cdn.divine.video`; both locators were included in
  the rumor, both downloads matched the ciphertext hash, and both temporary
  blobs were deleted successfully (HTTP 204).

### 5. Main-process exception when closing the browser

- **Status:** Fixed and runtime checked.
- **Reported:** 2026-11-28
- **Observed:** Closing the window after using the companion raised an uncaught
  `TypeError: Object has been destroyed`. The stack passed through
  `BrowserShell.contentBounds`, `layoutContentViews`, and `closeExtensionPanel`.
- **Change:** Panel destruction and window shutdown now skip content layout once
  the BrowserWindow is destroyed, and panel close checks the WebContents before
  closing it.
- **Check:** Closed the local `npm run dev` browser with the companion panel
  open. The process shut down without the reported `Object has been destroyed`
  exception.

### 8. Signer reconnect required after reopening the companion

- **Status:** Fixed when **Always allow** is selected. A session-only signer
  grant can prompt again after a full browser restart.
- **Observed:** Closing the panel clears its connection. Reopening required
  clicking **Connect NCC signer** again.
- **Change:** After the first successful connection, the companion remembers
  the signer's public key and reconnects on open through NCC's normal approval
  flow. While open, it follows the active NCC profile and loads that profile's
  isolated chat state.
- **Check:** In a fresh isolated dev profile with signer auto-approval disabled,
  connected a generated temporary identity and selected **Always allow** on the
  actual browser signer prompt. The panel connected. Closing and reopening the
  panel reconnected without another prompt. After restarting `npm run dev` with
  the same temp profile and identity, opening the panel restored the connected
  account without a prompt. The browser's signer-permissions store confirmed a
  trusted grant for the companion extension origin. No real profile or device
  was used.
- **Persistence note:** NCC's signer prompt has an unchecked **Always allow this
  option. Without that choice, signer approval is session-scoped and can prompt
  again after restarting NCC Browser. The companion's saved public key is only
  a reconnect hint; it is not a persistent signer authorization.
- **Follow-up evidence (2026-11-29):** The isolated temp profile currently has
  both `connectedSignerPubkey` and a trusted permission for its installed
  `extension:<id>` origin. This supports automatic reconnect for that same
  profile and extension install, but does not reproduce the user's reported
  prompt. Recheck the prompt's action and whether **Always allow** was selected;
  reconnecting after a profile switch or from a private session may ask again.
- **Current dev smoke (2026-11-29):** With a generated disposable browser
  identity, temporary automation agent and `NCC_SIGNER_AUTO_APPROVE=1`, the
  companion connected and published its invitation and inbox relay list to 3
  relays. Closing/reopening the panel reconnected automatically on its next
  poll; after a full `npm run dev` restart with the same temp profile and test
  identity, opening the panel restored the connected account without another
  Connect action. The extension panel console had no errors. Because signer
  prompts were auto-approved for this run, it does not establish whether a
  normal user's unchecked **Always allow** choice persists across
  a full browser restart.
- **Scope:** These checks used only the disposable local signer/profile. They
  verify local account and chat-state persistence, not cross-device delivery.

### Companion panel close button was rejected

- **Status:** Fixed and runtime checked
- **Observed:** The panel's **Close** action was rejected because extension
  pages have no browser tab in the extension sender record.
- **Change:** Close requests now require the calling extension page to match
  that extension's declared side-panel path, then close only that extension's
  panel.
- **Check:** Closed the companion with its own close action, reopened it from
  the toolbar action, and confirmed the current profile and all 13 chats
  returned without another signer connection in the same browser process. The
  isolated-profile full-restart check above also restored the conversation.

### 7. Android key-package decode error was reported as a lifetime failure

- **Status:** Fixed for decoding; broader compatibility remains open in issue 1
- **Reported:** 2026-11-28
- **Observed:** The companion's pinned `marmot-ts` 0.9.0 expected framed
  kind-30443 content and returned a misleading lifetime error for the emulator's
  `MDK/0.8.0` package.
- **Change:** The prototype build applies a narrow fallback decoder for the raw
  serialized KeyPackage form. Normal Marmot signature, identity, tag, and
  lifetime validation still runs. See `apply-marmot-compat.mjs`.
- **Check:** Confirmed the Android package passed decoding and reached the
  subsequent account-identity-proof validation; the invite still failed there.

### Repeated companion builds changed the Marmot compatibility bundle

- **Status:** Fixed; repeat-build check passed
- **Observed:** Rebuilding the extension repeatedly grew the generated Marmot
  bundle because the MDK/0.8 publisher wrapper was inserted again on every run.
- **Change:** `apply-marmot-compat.mjs` now checks for its wrapper marker before
  patching the pinned Marmot publisher source and fails clearly if neither the
  unpatched nor patched boundary is present.
- **Check:** Reinstalled the pinned extension dependencies and built twice.
  Both builds produced the same SHA-256 for `marmot.bundle.js`, and the patched
  publisher source contains exactly one wrapper.

### Tracked companion package lagged behind the tested source

- **Status:** Fixed; packaged artifact refreshed and validated.
- **Observed:** The tracked `extensions/white-noise-prototype.nccx` was version
  0.1.1 while the companion source and release notes were at 0.1.3. Users could
  therefore install a package missing later fixes and permissions.
- **Change:** Rebuilt the tracked `.nccx` from the current 0.1.3 source.
- **Check:** The packaging script validated the staged extension, packed the
  artifact, and the extracted package passed SDK validation as version 0.1.3.
  Its manifest includes the current `storage:large` and
  `blossom:group-image` permissions.
