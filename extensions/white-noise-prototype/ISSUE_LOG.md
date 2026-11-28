# White Noise Companion issue log

Use this file to record issues reported during prototype work. Move entries to
**Fixed** only after the change is built and its behavior has been checked.

## Open / in progress

### Android group details parity

- **Status:** Implemented and runtime checked.
- **Change:** Added a Group details action showing group name, MLS epoch,
  relay list, member count, member public keys, and admin roles from the
  Marmot group snapshot. Admins can remove another member after an explicit
  confirmation; Marmot `proposeRemoveUser` proposes removing all MLS leaves for
  that Nostr user, and the client verifies the member disappeared after commit.
- **Check:** The running dev companion displayed the details for the two-member
  `Interop Primal Ditto` group, including epoch 2, relay list, member rows, and
  the admin-only remove action. Member removal was not executed. A prior
  screenshot path could not capture the embedded panel, but its DevTools target
  confirmed it was open; the earlier pending status was stale.
- **Next:** Verify member removal on a disposable multi-member test group.

### Group and chat management parity

- **Status:** Basic actions implemented. Archive and rename verified.
- **Compared:** White Noise Android exposes group details and actions including
  rename, archive, and leave. The current Marmot TypeScript package supports
  metadata updates and leave, but has no archive operation.
- **Change:** Added group rename and leave through Marmot, local per-account
  archive state, an Archived list view, and group options from both the chat
  list context menu and conversation header.
- **Limit:** Archive only hides a group from the active chat list. It does not
  change MLS membership or relay data.
- **Check:** In the dev browser, archive removed a diagnostic group from the
  active list, it appeared in Archived, and restore returned it to Chats.
  Rename committed to the diagnostic group and restored its original name.
  Clear history removed message bubbles and displayed the empty state. Local
  delete removed a diagnostic chat from the list and closed its conversation.
  Leave was attempted on a two-member diagnostic group but Marmot rejected it
  because the current member is an active admin. The group remained listed.
  An explicit admin handoff flow was added and verified on the disposable
  NIP42 Result Trace group. It transferred admin rights to the other member,
  received leave acknowledgement, and removed the group from the local list.
- **Next:** Continue testing remaining companion features and cross-device
  interoperability.

### 1. Cross-device Marmot compatibility

- **Status:** Core text interoperability verified; continuing edge-case and media coverage.
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
- **Next:** Continue protocol edge-case coverage and finish the encrypted
  attachment send/receive check.

### 3. Drag-resize the companion panel

- **Status:** Implemented; drag gesture runtime check pending.
- **Reported:** 2026-11-28
- **Expected:** Drag the panel's left edge to resize it. Width should not be a
  slider in the settings area.
- **Change:** Added a keyboard-accessible left-edge resize handle backed by
  `ncc.runtime.setPanelWidth`; the BrowserWindow clamps widths to 280–600 px.
  No width slider is present in companion settings.
- **Check:** In the running `npm run dev` browser, the panel width changed from
  380 to 450 px through the API and was restored to 380 px. Pointer drag still
  needs a direct runtime gesture check.
- **Next:** Verify pointer drag changes the width and remains keyboard
  accessible.

### 4. Multiple account profiles

- **Status:** Implemented; runtime verification pending
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
- **Check:** Build and typecheck; switch between two disposable NCC profiles,
  then verify each profile reloads only its own chats after switching and after
  reopening the companion.

## Fixed

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
  flow. If the account changes, it asks the user to switch back before loading
  chats.
- **Check:** Closed the companion through the toolbar action, reopened it, and
  confirmed the NCC signer returned to Relay session active and all 12 saved
  chats loaded without clicking Connect.

## Fixed

### 6. Search results showed an invite-key action

- **Status:** Fixed; behavior check pending
- **Reported:** 2026-11-28
- **Observed:** After typing a few characters in Search chats, an empty result
  state showed **Create invite key package**, which is unrelated to searching.
- **Change:** Search misses now show a search-specific empty state and omit the
  invite-key action. See `panel.js` (`renderGroups`).
- **Check:** Rebuild the extension and verify a query with no matches and a
  query with matches in the local dev panel.

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
