# White Noise Companion issue log

Use this file to record issues reported during prototype work. Move entries to
**Fixed** only after the change is built and its behavior has been checked.

## Open / in progress

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
  the current selected relays.
- **Check:** Extension bundle builds. The local dev browser did not reload the
  newly built package during this run, so the relay metadata update path and
  welcome lookup change remain behavior-check pending. The user-facing invite
  acknowledgement currently reflects commit relay responses, not welcome
  delivery; do not treat it as proof that the invitee joined.
- **Next:** Restart the local dev app with a loopback-only Vite binding, then
  verify the updated extension package, welcome delivery on the Android
  profile's inbox relays, and messages in both directions.

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
