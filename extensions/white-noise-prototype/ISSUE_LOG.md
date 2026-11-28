# White Noise Companion issue log

Use this file to record issues reported during prototype work. Move entries to
**Fixed** only after the change is built and its behavior has been checked.

## Open / in progress

### Android group details parity

- **Status:** Implemented; runtime check pending.
- **Change:** Added a Group details action showing group name, MLS epoch,
  relay list, member count, member public keys, and admin roles from the
  Marmot group snapshot. Admins can remove another member after an explicit
  confirmation; Marmot `proposeRemoveUser` proposes removing all MLS leaves for
  that Nostr user, and the client verifies the member disappeared after commit.
- **Check:** The Marmot 0.9.0 declarations and implementation export
  `proposeRemoveUser`. The extension bundle and repository typecheck pass. I
  launched the app with `npm run dev` and the NCC MCP authenticated, but
  clicking the extension toolbar action did not visibly open the panel in the
  captured window, so the details and removal flows still need runtime checks.
- **Next:** Diagnose why the installed extension action does not reveal its
  side panel, then verify details and member removal on a multi-member test
  group.

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

- **Status:** In progress
- **Reported:** 2026-11-28
- **Observed:** White Noise Android 2026.11.17's key package passes the
  companion's raw `MDK/0.8.0` decode and account-identity-proof checks. The
  companion can publish a kind-445 invite commit acknowledged by two relays,
  and its local group advances to epoch 1 with both members. White Noise still
  does not show the group or its welcome. The Android profile advertises a
  kind-10050 inbox on White Noise EU/US relays; the first test used a smaller
  relay set and did not deliver the welcome. After adding hosted relays, a
  second invite commit was accepted, but the recipient still did not display
  the group. Message exchange in both directions is not yet verified.
- **Change:** The adapter now reads the recipient's kind-10050 inbox relay list,
  and the relay settings save path refreshes live subscriptions and proposes
  authenticated MLS relay metadata updates for existing groups. New groups use
  the current selected relays. The package now requests `nostr:nip44`, which
  the companion needs to decrypt recipient key packages and construct MLS
  welcomes. Extension relay publication also answers NIP-42 AUTH challenges
  using the active NCC identity and validates the returned event.
- **Check:** The built package contains the NIP-44 permission. The invite trace
  now reaches welcome publication, but the White Noise EU/US inbox relays return
  connection failures. Direct shell probing cannot resolve relay hosts in this
  restricted environment, so it cannot determine whether that failure is the
  dev environment, the Electron app, or relay availability. A direct WebSocket probe with network access also failed for both hosted
  White Noise inbox relays, while Ditto opened. The companion now reports the
  welcome delivery result separately from the group commit. Cross-device
  group appearance and two-way message exchange remain unverified.
- **Next:** Repeat welcome publication from the running NCC dev browser where
  its relay networking is available, confirm a relay accepts the welcome, then
  verify the group appears in Android and messages work in both directions.

### 2. Chat file and media sharing

- **Status:** In progress
- **Reported:** 2026-11-28
- **Expected:** The in-composer plus menu should offer file/media sharing, and
  supported files or images pasted into the composer should be staged as
  attachments. Sending and receiving must use Marmot encrypted media.
- **Next:** Implement staging, paste handling, encrypted upload/download, and
  attachment rendering in the chat view.

### 3. Drag-resize the companion panel

- **Status:** Open
- **Reported:** 2026-11-28
- **Expected:** Drag the panel's left edge to resize it. Width should not be a
  slider in the settings area.
- **Next:** Add an edge resize handle backed by the NCC panel resize API and
  remove the settings slider.

### 4. Multiple account profiles

- **Status:** Open
- **Reported:** 2026-11-28
- **Expected:** Integrate White Noise's multiple accounts with NCC Browser's
  profile/account model cleanly, including clear account switching and isolated
  Marmot state per account.
- **Next:** Map White Noise account switching and NCC profile identity behavior
  before choosing the storage and signer boundaries.

### 5. Main-process exception when closing the browser

- **Status:** Fixed in source; behavior check pending
- **Reported:** 2026-11-28
- **Observed:** Closing the window after using the companion raised an uncaught
  `TypeError: Object has been destroyed`. The stack passed through
  `BrowserShell.contentBounds`, `layoutContentViews`, and `closeExtensionPanel`.
- **Change:** Panel destruction and window shutdown now skip content layout once
  the BrowserWindow is destroyed, and panel close checks the WebContents before
  closing it.
- **Check:** Rebuild and close the local dev browser with the companion open.

### 8. Signer reconnect required after reopening the companion

- **Status:** Fixed in source. Dev browser check pending.
- **Observed:** Closing the panel clears its connection. Reopening required
  clicking **Connect NCC signer** again.
- **Change:** After the first successful connection, the companion remembers
  the signer's public key and reconnects on open through NCC's normal approval
  flow. If the account changes, it asks the user to switch back before loading
  chats.

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
