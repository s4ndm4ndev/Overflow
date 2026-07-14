# Changelog

Sessions with Claude Code don't sync across machines — only what's committed
to git does. This file is the running record of *why* things changed, not
just what, so picking this up from a different machine (or a fresh session)
starts from real context instead of re-deriving it from diffs.

Newest first.

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
  reflows the *entire page* down by its own height. `clickGenerateButton()`
  was measuring the button's coordinates *before* requesting the attach+
  click, so by the time the click actually dispatched, the page had already
  shifted and the click landed ~30-40px above the real button — no error,
  since the debugger commands themselves succeeded, just clicking nothing.
  Fixed by splitting the previously-atomic attach/click/detach into three
  separate steps (`DEBUGGER_ATTACH`, `DEBUGGER_CLICK`, `DEBUGGER_DETACH`) so
  the content script can measure the button *after* attaching and the
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
  specifically (previously matched *any* Flow tab anywhere in the browser,
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
