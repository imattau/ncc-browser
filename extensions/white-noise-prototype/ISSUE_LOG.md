# White Noise Companion issue log

Use this file to record issues reported during prototype work. Move entries to
**Fixed** only after the change is built and its behavior has been checked.

## Open / in progress

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

### Group photos are not yet interop-verified

- **Status:** UI and Marmot upload/read/clear wiring implemented; runtime check
  remains open.
- **Change:** Admins can choose or remove a group photo in group settings. The
  companion accepts JPEG, PNG and WebP up to 5 MB, calls Marmot's encrypted
  group-image APIs, uses the account's Blossom server list, and shows available
  photos in the chat list and editor.
- **Check:** Extension build, JavaScript syntax checks and diff whitespace
  checks passed. The `npm run dev` process started, but the browser MCP showed a
  blank renderer and did not expose the companion panel, so upload, relay
  publication and cross-device image reads were not exercised.

### Group and chat management parity

- **Status:** Group actions and core chat-list controls implemented; Android
  parity remains incomplete.
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
  group details. Expired messages are hidden from the companion transcript and
  chat preview; Marmot local history remains cached until the user clears it.
- **Limit:** Archive, pin, mute preference, unread and ordering are local to
  this NCC profile. Desktop notifications are not implemented, so mute does
  not currently suppress notifications. Folders remain to do. Group-photo
  runtime interop is tracked above.
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
- **Next:** Continue testing remaining companion features and cross-device
  interoperability.

### Android reply reference shows an unresolved event preview

- **Status:** Open; quote rendering works, but Android showed an extra
  `Event not found` link preview in one check.
- **Observed:** The companion's NIP-C7 reply displayed its quote correctly in
  White Noise Android, plus a separate preview for the `nostr:nevent` reference
  that said the event could not be found. The Android reply in the reverse
  direction rendered its quote correctly in the companion.
- **Next:** Recheck against the Android release currently installed in the
  emulator and determine whether White Noise should resolve the q-tagged event
  from MLS history or whether the companion's reference needs adjustment. The
  current outgoing event follows NIP-C7's single `q` tag plus `nevent` format.

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
  reload from local extension storage after restart.
- **Additional interop check:** With White Noise Android online, the companion
  created `NCC_Online_Invite_2026-11-28` and invited the Android profile. Android
  received the Welcome, displayed the group preview, and accepted it. Android
  saw a companion message, and the companion received an Android reply. The
  companion panel was closed and reopened; the group (2 members, epoch 2) and
  both reply histories loaded from extension storage.
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

- **Status:** Implemented and verified in both directions with White Noise
  Android.
- **Change:** Replies are kind-9 rumors with one `q` tag and a
  `nostr:nevent` reference followed by the reply text. The panel previews the
  reply target, supports cancelling, and renders a contextual quote when the
  parent is in loaded history. Attachment replies are currently disabled.
- **Check:** Android displayed the companion reply in the expected quote
  context. An Android reply to a companion message rendered with its matching
  quote in the companion.

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
  `https://blossom.primal.net`; admins can enable media in older groups. Added
  explicit host permissions for the tested White Noise Blossom/CDN endpoints.
  The chat plus menu opens a multi-file picker, clipboard image/file pastes
  stage files beside the composer, and received attachments download on demand
  and decrypt before display/save. A durable per-account Marmot `rewindStore`
  retains authenticated source epochs across restarts. Limits are 25 MB per
  file, 10 files and 100 MB per message.
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
  correctly.

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

- **Status:** Fixed and runtime checked.
- **Observed:** Closing the panel clears its connection. Reopening required
  clicking **Connect NCC signer** again.
- **Change:** After the first successful connection, the companion remembers
  the signer's public key and reconnects on open through NCC's normal approval
  flow. While open, it follows the active NCC profile and loads that profile's
  isolated chat state.
- **Check:** Closed the companion through the toolbar action, reopened it, and
  confirmed the NCC signer returned to Relay session active and all 13 saved
  chats loaded without clicking Connect.

### Companion panel close button was rejected

- **Status:** Fixed and runtime checked
- **Observed:** The panel's **Close** action was rejected because extension
  pages have no browser tab in the extension sender record.
- **Change:** Close requests now require the calling extension page to match
  that extension's declared side-panel path, then close only that extension's
  panel.
- **Check:** Closed the companion with its own close action, reopened it from
  the toolbar action, and confirmed the current profile and all 13 chats
  returned without another signer connection.

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
