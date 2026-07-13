# Changelog

Sessions with Claude Code don't sync across machines — only what's committed
to git does. This file is the running record of *why* things changed, not
just what, so picking this up from a different machine (or a fresh session)
starts from real context instead of re-deriving it from diffs.

Newest first.

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
