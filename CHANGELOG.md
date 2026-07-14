# Changelog

Sessions with Claude Code don't sync across machines — only what's committed
to git does. This file is the running record of _why_ things changed, not
just what, so picking this up from a different machine (or a fresh session)
starts from real context instead of re-deriving it from diffs.

<<<<<<< HEAD
Newest first.

=======
**Commit convention**: do not add a `Co-Authored-By: Claude ...` trailer to
commit messages in this repo. A few earlier commits had one and had to be
rewritten out of history to remove it — don't reintroduce it.

Newest first.

## 2026-07-14 — Chrome Web Store MV3 pre-submission check: tighten manifest permissions

- **Request**: final check before submitting to the Chrome Web Store.
- **Found and fixed in [manifest.json](manifest.json)**:
    - `scripting` permission removed — declared but never called anywhere;
      both content scripts are injected declaratively via `content_scripts`,
      not `chrome.scripting.executeScript`.
    - `activeTab` permission removed — every `chrome.tabs.*` call
      (`background.js`) only ever targets Flow tabs under
      `https://labs.google/fx/*`, which `host_permissions` already grants
      persistent access to; `activeTab`'s click-triggered grant added nothing.
    - `host_permissions` narrowed from `https://labs.google/*` to
      `https://labs.google/fx/*` to match what the content scripts and
      `background.js`'s own tab-detection regexes actually scope to.
    - Added `"minimum_chrome_version": "114"` — the `"world": "MAIN"`
      content-script field needs Chrome 111+ and `sidePanel` needs 114+;
      without this, installs on older Chrome would fail silently instead of
      showing Chrome's own "not compatible" message.
- **Flagged, not fixed (a judgment call, not a manifest defect)**: the
  `debugger` permission is used to dispatch a genuinely trusted click that
  bypasses Flow's own anti-automation gate on its Generate button (see the
  2026-07-13 "Real Flow page automation" entry below for why it exists).
  This is implemented cleanly — attach/click/detach wrapped in
  `try/finally` in [content-scripts/flow.js](content-scripts/flow.js) so
  the debugging session always releases — but `debugger` is one of the
  Chrome Web Store's "powerful permissions" requiring a written
  justification in the dashboard, and a reviewer may specifically question
  a use case that defeats a site's own anti-bot gating on a Google product.
  Left as-is at the user's direction; worth budgeting review time for.
- **Confirmed working** — reloaded the unpacked extension with the
  narrowed `host_permissions` and removed `activeTab`/`scripting`; tab
  detection, queue automation, and downloads all behaved normally.

## 2026-07-14 — First alpha release: version scheme, `bump-version.js`, README rewrite

- **Request**: mark this the first public alpha, with a version that "looks
  like `1.0.0-alpha`," rewrite the stale README, and automate version bumps.
- **Chrome constraint discovered**: MV3's `manifest.json` `version` field
  must be 1-4 dot-separated integers — Chrome rejects `-alpha`/`-beta`
  suffixes outright, even for unpacked/dev loads, so a literal
  `"1.0.0-alpha"` isn't loadable. Presented the standard workaround
  (`version_name` for a free-text display label) vs. using the version
  field's 4th segment as a numeric build/pre-release counter with no text
  suffix at all. User chose the latter — bumped [manifest.json](manifest.json)
  to `1.0.0.0`; alpha/beta/stable status lives only in README/Changelog now,
  not the manifest.
- **Added [scripts/bump-version.js](scripts/bump-version.js)**: `node
scripts/bump-version.js <major|minor|patch|build>` bumps one segment and
  zeroes everything to its right (standard semver-style behavior). First
  version used `JSON.parse`/`JSON.stringify` to rewrite the whole file, which
  silently reformatted every array in `manifest.json` onto multiple lines
  (Node's stringify doesn't preserve the original inline-array style) —
  caught by diffing after a test run, before it was ever committed. Rewrote
  to do a targeted regex replace of just the `"version": "..."` line instead,
  leaving the rest of the file's formatting untouched.
- **Rewrote [README.md](README.md)**: the old one described Overflow as a
  "scaffold only" with placeholder DOM selectors and TODO functions — that
  was true at the initial-scaffold commit but every feature built since
  (queue automation, Consistent Character, Auto Download, focus auto-pause,
  About tab, blocking overlays) had left it undocumented and actively
  misleading. Replaced with the real feature list, unpacked-install steps,
  the versioning scheme note above, and an updated known-limitations list
  (dropped the resolved items like download naming/subfolders; kept the
  ones still true, e.g. queue is memory-only, no Web Store listing yet).

## 2026-07-14 — Fix uncaught "Could not establish connection" errors in background.js

- **Report**: `chrome://extensions` error log showed repeated `Uncaught (in
promise) Error: Could not establish connection. Receiving end does not
exist.` from `background.js`.
- **Root cause**: `checkAndBroadcastFocusState()` (added in the auto-pause
  feature) calls `chrome.runtime.sendMessage({ target: "panel", type:
"FLOW_FOCUS_CHANGED", ... })` with no callback, both on the normal focus-
  transition path and the `WINDOW_ID_NONE` (focus left Chrome entirely)
  path. With no callback, MV3 returns a Promise instead of using the
  callback+`lastError` pattern — and that promise rejects with this exact
  message whenever there's no side panel open to receive the broadcast,
  which is a completely normal state (user hasn't opened the panel, or just
  closed it), not a real failure. Nothing caught the rejection, so it
  surfaced as an uncaught error every time a tab/window focus change fired
  while the panel was closed.
- **Fix**: added `.catch(() => {})` to both `chrome.runtime.sendMessage(...)`
  calls in `checkAndBroadcastFocusState()` in [background.js](background.js).
  Purely swallows the expected "no receiver" case; doesn't change behavior
  when the panel is actually open and listening.

## 2026-07-14 — Bump version to 1.0.0

- Manifest was still at `0.1.0` despite the extension having a full feature
  set (queue automation, consistent character, auto-download, focus
  auto-pause, etc.). Bumped [manifest.json](manifest.json) to `1.0.0` at the
  user's request, now that the new About tab surfaces the version number
  directly in the UI. The About tab needed no code change — it reads the
  version from `chrome.runtime.getManifest()` rather than a hardcoded value.

## 2026-07-14 — Add About tab (version, author, website link)

- **Request**: surface the extension version, author name ("S4NDM4N"), and a
  link to https://s4ndm4n.dev/ somewhere in the side panel.
- **Fix**: split the side panel into two tabs — "Controls" (existing
  prompts/queue UI, unchanged, now wrapped in `#controls-view`) and "About"
  (new `#about-view`) — via a `.tab-bar` under the header in
  [sidepanel.html](sidepanel/sidepanel.html). No tab system existed before
  this; it's a new pattern built from the existing design tokens
  (`sidepanel.css`'s `:root` vars), not an extension of anything prior.
- Version is read dynamically via `chrome.runtime.getManifest().version` in
  `sidepanel.js` rather than hardcoded, so it can never drift from
  [manifest.json](manifest.json)'s own `"version"` field.
- The website link reuses the existing `.link-button` + `chrome.tabs.create()`
  convention already used for the download-settings link
  (`sidepanel.js`'s `openDownloadSettingsBtn` handler), instead of a plain
  `<a target="_blank">`, to stay consistent with how every other external
  link in this codebase works. Listed as a third "Web Site" row in the
  `.about-meta` list alongside Version/Author (rather than a standalone
  button below it), per follow-up request.

## 2026-07-14 — Reset panel to starting state after a clean batch

- **Request**: after a batch finished, the panel only ever cleared the
  in-memory `queue` array (`runQueue()`'s natural-completion branch) —
  the prompts textarea was left populated. Since the Start button rebuilds
  the queue from the textarea only when `queue` is empty, this meant
  clicking Start again after a finished batch silently re-ran the exact
  same prompts instead of prompting for a fresh batch.
- **Fix**: added `resetToStartingState()` in `sidepanel/sidepanel.js`,
  called from `runQueue()`'s natural-completion branch. Clears the prompts
  textarea plus `queue`/`currentIndex`. Deliberately does **not** touch
  Consistent Character (toggle, uploaded character images) or Auto Download
  (toggle, download folder) — confirmed with the user these should persist
  batch to batch, not reset. Delay min/max fields were also confirmed to be
  a tuned preference rather than a per-batch input, so those are left alone
  too. Isolation is by construction: the new function never references
  `consistentCharacterToggleEl`, `characterRecords`, `autoDownloadEl`,
  `downloadFolderEl`, or the delay fields at all, and Consistent
  Character/Auto Download's actual persisted state lives in
  `chrome.storage.local`/IndexedDB, entirely separate stores from the
  in-memory queue/DOM fields being cleared here.
- **Only resets on a fully clean run**: if any prompt in the batch errored
  (`queue[i].status === "error"`), the reset is skipped and a distinct
  status message shows instead ("some prompts failed. Review and try
  again.") — confirmed with the user that an errored run should leave the
  textarea in place for the user to see/retry, rather than silently wiping
  it along with the evidence of what failed. The existing unconditional
  `queue = []` on natural completion is unchanged either way — only the new
  textarea/index reset is gated on the error check.

## 2026-07-14 — Auto-pause the queue when the Flow tab isn't focused

- **Request**: the queue kept running even after switching away to another
  tab or window, which risks Chrome's background-tab timer throttling
  silently stalling or breaking a long unattended run — content scripts on a
  tab that isn't the active tab of its window get their timers throttled by
  Chrome, and the whole automation (`flow.js`'s `sleep()`s, its
  `MutationObserver`-based result wait, etc.) runs there.
    - Note: switching to another _app_ (OS-level focus loss) while the Flow
      tab stays the visible/active tab in its window does _not_ trigger this —
      that's not the condition Chrome's tab throttling actually keys off of,
      only "is this the active tab of a window" is.
- **Fix**: `background.js` now tracks whether the Flow project tab is the
  active tab of the last-focused window via `chrome.tabs.onActivated` and
  `chrome.windows.onFocusChanged` (the latter special-cased for
  `WINDOW_ID_NONE`, i.e. focus left every Chrome window entirely, which a
  `lastFocusedWindow`-based tab query wouldn't reliably reflect on its own).
  On any actual transition it broadcasts `{target:"panel",
type:"FLOW_FOCUS_CHANGED", payload:{focused}}`.
    - `sidepanel.js` had no `chrome.runtime.onMessage` listener at all before
      this — the "panel" broadcast target existed in `background.js`'s
      comments but nothing on the panel side ever consumed it. Added one,
      tracking a new `focusPaused` flag kept deliberately separate from the
      user's own `paused` (Pause button) flag, so neither clobbers the other:
      regaining focus clears `focusPaused` but leaves a manual pause in place;
      manually pausing while unfocused doesn't get silently cleared by a
      refocus. Both queue wait loops (`runQueue()`, `delayWithCountdown()`)
      now block on `paused || focusPaused`.
    - Deliberately auto-_resumes_ (not just auto-pauses) the moment the Flow
      tab becomes the active tab again, rather than requiring a manual Start
      click — matches the existing ask to not have to babysit the tab; the
      pause is purely a defensive measure for the unattended-and-throttled
      window, not a request for extra manual steps once back.
- **Confirmed working** — auto-pause/resume behaves as expected when
  switching tabs away from and back to the Flow project.

## 2026-07-14 — Fix side panel scroll clipping + drop false "missing character" flags

- **Scroll bug**: content longer than the panel (queue items, character
  list) couldn't be scrolled into view. Two fix attempts failed under live
  testing before landing on the real cause: `.status-bar` being
  `position: fixed` with no reserved space beneath it wasn't the core
  issue — `html, body { height: 100% }` + `overflow-y: auto` on body did
  nothing (percentage heights depend on the whole ancestor chain resolving
  a height, unreliable inside the side panel host), and swapping to
  `height: 100vh` on body _also_ did nothing — confirming the Chrome side
  panel host just doesn't reliably honor document/body-level overflow
  scrolling at all, regardless of how body's height is computed. Fixed by
  giving up on body-level scrolling entirely: `body` is now a fixed
  `height: 100vh` flex column with `overflow: hidden` (never scrolls
  itself), everything except the footer is wrapped in a new `#scroll-area`
  div that's `flex: 1; min-height: 0; overflow-y: auto` (an explicit inner
  scroll container, not reliant on the document's own scrolling), and
  `.status-bar` dropped `position: fixed` in favor of just being the last
  flex child — pinned to the bottom by layout instead of positioning. See
  [sidepanel.html](sidepanel/sidepanel.html) and
  [sidepanel.css](sidepanel/sidepanel.css).
- **False "missing character" flags**: `character-matcher.js`'s `missing`
  detection scanned prompt text for _any_ ALL-CAPS 2+ letter token not in
  the uploaded character list (e.g. `WIDE SHOT`, `CU`, `INT`) and flagged
  it as a referenced-but-not-uploaded character. Scene-only prompts with no
  intended character at all routinely contain capitalized camera/shot
  directions, so this wrongly marked those prompts as errors. Removed the
  ALL-CAPS heuristic entirely — `matchCharactersInText()` now only returns
  `{ matched }` (positive matches against uploaded names, negation-aware as
  before); there is no more speculative "missing" bucket. Removed the
  now-dead `missingCharacters` plumbing from
  [sidepanel.js](sidepanel/sidepanel.js) (queue item field, badge
  rendering) and the `.missing-character-badge` rule from
  [sidepanel.css](sidepanel/sidepanel.css).

## 2026-07-14 — Consistent Character: upload reference images, auto-attach by name match

- **New feature**: a "Consistent Character" toggle in the side panel. When
  on, an upload panel appears (only then — hidden otherwise) where the user
  drops in reference images named after characters (e.g. `narrator.png`).
  Each queued prompt is scanned for character names; matched images are
  uploaded to Flow and attached to the composer _before_ the prompt text is
  set, so the same character stays visually consistent across a batch
  instead of drifting each generation. Number of images attached per
  prompt equals the number of distinct characters that prompt references.
- **Root discovery going in**: none of this existed yet — Overflow had no
  image upload UI, no `chrome.storage` usage anywhere, and nothing in
  `flow.js` drove Flow's own image-attach control (the "+" button was
  found and explicitly filtered out as a false match, never used). This
  was greenfield work, not a retrofit.
- **Live-inspected Flow's actual attach-image UI** (same methodology as the
  original prompt-composer/Generate-button work — see the two entries
  below) before writing any selector code, using throwaway test PNGs
  uploaded and trashed afterward, no lasting change to the test project:
    - A plain `<input type="file" multiple accept="image/*">` already exists
      in the DOM at all times — no React-controlled dropzone.
    - The "+" button (icon ligature `add_2` — the same button
      `findGenerateButton()` already had to filter out, sharing Generate's
      hidden "Create" accessible name) opens an asset picker, not a direct
      upload. The picker has a "Search assets" input, category filters,
      "Upload media" (same hidden input), and "Add to Prompt" (attaches the
      selected asset as a thumbnail chip in the composer).
    - **Mixed result on `chrome.debugger`**: uploading via the hidden input
      and clicking the "+" / "Add to Prompt" buttons all accept plain
      synthetic events — confirmed live. But **selecting a specific tile in
      the picker's list does not** — neither `.click()` nor a full
      `pointerdown`/`mousedown`/`pointerup`/`mouseup`/`click` sequence
      changed the selection or preview; only a genuinely trusted click did.
      So tile selection reuses the existing `DEBUGGER_ATTACH`/`CLICK`/
      `DETACH` round-trip `clickGenerateButton()` already used for Generate
      — `background.js`'s `debuggerDispatchClick(tabId, x, y)` turned out to
      be fully generic (arbitrary coordinates, nothing Generate-specific),
      so it needed zero changes, just reuse.
    - Multiple images attach as separate chips (confirmed with two uploads
      at once) — matches the multi-character-per-prompt requirement
      natively. Asset tiles expose their filename as plain text in the
      picker DOM, which is how the correct tile gets found among several
      uploaded characters (rather than trusting picker's default "Recent"
      selection, which pointed at the wrong image as soon as a second
      upload existed).
    - The picker had to be scoped away from the project's background media
      grid — it renders tiles with the _same_ filename text at the same
      time the picker is open, so an unscoped filename search matched the
      wrong element. Fixed by scoping to the nearest common ancestor of the
      picker's own "Search assets" input and "Upload media" button.
- **Negation handling**: a prompt can say a character is explicitly
  _absent_ (e.g. `"No NARRATOR in frame."`). The matcher checks the 1-3
  words immediately preceding a name, within the same sentence, against a
  small negation-cue list (`no`, `not`, `without`, `excluding`, `minus`);
  a fully-negated character is neither attached nor flagged as a missing
  reference — flagging it would be noise, not a real problem, since the
  prompt is deliberately excluding it.
- **New files**: `sidepanel/character-store.js` (IndexedDB-backed image
  store — chosen over `chrome.storage.local` since that API's ~10MB quota
  isn't meant for binary blobs; images are downscaled to a 1024px long
  edge on upload) and `sidepanel/character-matcher.js` (pure name-matching
  logic, no `chrome.*`/DOM dependencies).
- **Verified directly** (not just by inspection): 9 matcher test cases via
  Node covering the exact negation example above, multi-character prompts,
  dedup of repeated mentions, and sentence-scoped negation — all passing;
  the full `CharacterStore` lifecycle (add/list/get/remove, including the
  2048×1200 → 1024×600 downscale) exercised live against real IndexedDB;
  and the blob → data URL → blob → File round trip that carries an image
  from the side panel's IndexedDB to the content script's `attachCharacterImage()`,
  confirmed byte-for-byte lossless. Loading the unpacked extension and
  driving the side panel UI itself (toggle, drag-drop, a live queue run)
  still needs a manual pass — `chrome://extensions` and the side panel
  surface aren't reachable through the browser automation used for the
  rest of this work.

## 2026-07-14 — Download naming/subfolder fix (route through onDeterminingFilename)

- **Bug reports**: auto-download was saving files straight into the default
  Downloads folder (ignoring the subfolder textbox) and naming them after
  Flow's own asset UUID (e.g. `7546f153-eb33-46a4-b611-d2dc6b606a73.jpg`)
  instead of the intended zero-padded `001.jpg`, `002.jpg`, etc.
- **Root cause**: `sidepanel.js`'s `downloadResult()` was passing the desired
  `filename` (subfolder + zero-padded name) directly as an option to
  `chrome.downloads.download()`. That option is not authoritative — Chrome
  can silently fall back to a name derived from the download's own URL/
  response instead of erroring, which is exactly what was happening here.
  `chrome.downloads.onDeterminingFilename` is the API's actual override
  point (it always wins), so filename decisions moved there.
- **Fix**: `background.js` now owns the whole download call. It exposes a
  new `DOWNLOAD_RESULT` message (`{url, folder, baseIndex}`); on receipt it
  pushes `{folder, baseIndex}` onto a small FIFO queue and calls
  `chrome.downloads.download({url, saveAs:false})`. A single
  `chrome.downloads.onDeterminingFilename` listener shifts the next queued
  entry and calls `suggest({filename, conflictAction:"uniquify"})`. The
  queue (not a downloadId-keyed map) exists because nothing guarantees the
  `.download()` callback fires before `onDeterminingFilename` does for the
  same download — pushing synchronously right before calling `download()`
  sidesteps that ordering question. Safe here since we only ever have one
  of our own downloads in flight at a time.
    - Bonus fix from the same change: extension is now derived from the real
      `downloadItem.mime` Chrome reports (falling back to the existing
      suggested filename's extension, then `.jpg`) instead of a hardcoded
      `.png` for images — Flow actually serves images as `image/jpeg`.
    - `sidepanel.js`'s `downloadResult()` is now just a thin message-sender:
      builds `{folder, baseIndex}`, sends `DOWNLOAD_RESULT`, and keeps its
      existing 8-second Save-As-dialog safety timeout around the response.
- **Confirmed working** after reloading the unpacked extension — subfolder
  and zero-padded filenames both land correctly now.

> > > > > > > 0a6eba81e94bc7fb31cd81ddf0fa6cb8d66b0046

## 2026-07-13 — Auto-refresh, blocking overlays, and queue UI polish

- **Auto-refresh the Flow tab**: `background.js` gained a `REFRESH_FLOW_TAB`
  message that reloads the active Flow project tab and waits for it to
  actually be usable before responding — fires once (silently) when the
  side panel opens, and again (surfacing failures) right before every Start
  queue click, so automation always begins from a clean page load.
    - First version waited for the tab's "complete" load event plus a flat
      800ms buffer, which wasn't consistently enough for Flow's React app to
      finish mounting — the very first queued prompt after Start would run
      against a composer that didn't exist yet (visible as a brief "error"
      before the next prompt succeeded). Fixed by having `flow.js`'s PING
      response report `composerReady: !!findPromptInput()`, and having
      `background.js` poll that after "complete" fires instead of guessing
      with a fixed delay.
- **Blocking overlay for "not on Flow"**: a full-panel modal (confirmed
  `position: fixed`, `z-index: 100` — physically blocks every control
  underneath it) now shows whenever the tab-detection poll fails, with a
  button that opens `labs.google/fx/tools/flow` in a new tab. Found and
  fixed a real CSS bug during testing: `.blocking-overlay` set
  `display: flex` directly, which — being author CSS — always overrode the
  browser's built-in `[hidden] { display: none }` rule at equal specificity.
  The overlay's `hidden` attribute was being toggled correctly in JS the
  whole time; it just never had any visual effect once shown once. Fixed
  with a higher-specificity `.blocking-overlay[hidden] { display: none; }`.
- **Agent-mode detection**: found the DOM signal via live (read-only)
  inspection — Flow's "Agent" composer toggle is a real
  `<button aria-pressed="true|false">`, a stable accessibility attribute,
  not a generated class. `flow.js`'s PING response now reports
  `agentModeOn`, and the panel refuses to run (same blocking-overlay
  treatment, no action button since the fix has to happen on Flow's own
  page) while it's on — this automation was never built against Agent
  mode's different, chat-style interaction.
- **Queue/download UI polish**: Clear queue button now disables itself
  correctly when the queue is empty (previously stayed clickable always);
  download folder field has a real default value (not just a placeholder)
  and stays disabled until auto-download is checked; downloaded filenames
  are now just zero-padded numbers ("001.png") instead of embedding the
  prompt text; uploading a .txt file of prompts no longer strips blank
  lines between them (was purely cosmetic breakage — the blank lines were
  already ignored during actual queue-building — but destroyed the
  readability of paragraph-separated prompts); prompts textarea is now a
  fixed 260px instead of a small resizable box.

## 2026-07-13 — Fixed the debugger click landing on nothing

- Root cause of "text types fine, but nothing ever submits or generates,"
  found by comparing screenshots before/after `chrome.debugger.attach()`:
  attaching triggers Chrome's "is debugging this browser" infobar, which
  reflows the _entire page_ down by its own height. `clickGenerateButton()`
  was measuring the button's coordinates _before_ requesting the attach+
  click, so by the time the click actually dispatched, the page had already
  shifted and the click landed ~30-40px above the real button — no error,
  since the debugger commands themselves succeeded, just clicking nothing.
  Fixed by splitting the previously-atomic attach/click/detach into three
  separate steps (`DEBUGGER_ATTACH`, `DEBUGGER_CLICK`, `DEBUGGER_DETACH`) so
  the content script can measure the button _after_ attaching and the
  reflow has settled, not before.
- Along the way, also fixed a real (if secondary) bug: `setPromptText()`'s
  fixed 30s timeout didn't scale with prompt length, and slow/detailed
  prompts (~100+ words) at the new human-like typing pace could legitimately
  take longer than that — timing out and reporting "error" while the
  now-orphaned typing loop in `flow-main-world.js` kept running unseen in
  the background, sometimes overlapping with the next prompt's typing and
  corrupting the editor. Fixed the timeout to scale with word count, and
  added a request-id guard in `flow-main-world.js` so a superseded typing
  loop bails out instead of continuing to mutate the editor.

## 2026-07-13 — Real Flow page automation (working, needs polish)

- Discovered Flow's Generate button ignores every synthetic click a content
  script can produce — `.click()`, full pointer/mouse event sequences, even
  a synthetic Enter, all silently did nothing. Most likely a deliberate
  anti-automation gate (real compute cost per click). Fixed by dispatching a
  genuinely trusted click via `chrome.debugger` (CDP) from the background
  service worker, attached only for the instant of the click.
- Discovered the Slate.js prompt editor's internals (React fiber state) are
  not reachable from a content script's isolated world. Added
  `content-scripts/flow-main-world.js`, injected into the page's actual JS
  world (`"world": "MAIN"` in the manifest), which walks the React fiber
  tree to reach Slate's editor instance and types directly via
  `editor.insertText()`, word-by-word with jittered pauses. Relays results
  back to the isolated-world script via `window.postMessage`, since MAIN
  world has no `chrome.*` access.
- Fixed `findGenerateButton()` — it was grabbing the composer's "+"
  attach-media button, not the submit button (both share the same hidden
  "Create" accessible name). Now identified by its `arrow_forward` icon
  ligature instead.
- `waitForResult()` no longer requires the `virtuoso-item-list` gallery
  container to exist first — it isn't present in every project view (e.g.
  a chat/agent-style composer). Watches the whole document for a tile
  gaining its finished-state edit link instead.
- Queue is now resumable: Start continues unfinished items instead of
  always rebuilding from the textarea, and a queue that finishes naturally
  auto-clears so the next Start doesn't silently repeat it. Added a
  "Clear queue" button.
- Randomized human-like pauses added between typed words and before
  clicking Generate, instead of machine-speed instant fill + click.
- Handles Chrome's "Ask where to save each file" downloads setting, which
  would otherwise stall the whole queue indefinitely on a native Save
  dialog — shows a warning with a link to Chrome's download settings and
  times out after 8s instead of hanging forever.

## 2026-07-03 — Flow tab/project detection + first real selectors

- Tab detection rewritten to check the active tab of the focused window
  specifically (previously matched _any_ Flow tab anywhere in the browser,
  so it stayed "detected" even after switching away). Now distinguishes
  "not on Flow," "on Flow but no project open," and "ready."
- First real DOM selectors from live inspection: the prompt input is a
  Slate.js contenteditable editor, not a `<textarea>`; the submit button's
  accessible name is "Create," not "Generate" as originally assumed.
- Completion detection via a tile gaining an edit link (`/edit/<asset-id>`),
  rather than guessing from loading-state classes.
- Discovered the generated asset is a normal same-origin URL, not a
  page-scoped `blob:` URL — downloads go straight through
  `chrome.downloads.download()` instead of a blob-to-data-URL relay.

## 2026-07-03 — Initial scaffold

- Manifest V3 extension shell: side panel UI, background message relay,
  content script skeleton with placeholder selectors.
- Repo hygiene: `.gitignore` added; `.claude/` untracked from version
  control (local tooling config, not meant to be shared via git).
