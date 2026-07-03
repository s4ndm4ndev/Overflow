# Overflow

Free, bulk prompt automation for Google Flow. Paste a list of prompts, walk away, come back to generated results — no paid tier gatekeeping basic queueing.

## Status: scaffold only

This is a working extension *shell*, not a finished tool. It installs, opens
a side panel, and has a full queue UI — but it can't actually talk to the
Flow page yet, because the DOM selectors in `content-scripts/flow.js` are
placeholders. Everything marked `TODO` in that file needs a real selector
pulled from Flow's live page.

## What's built

- `manifest.json` — Manifest V3, side panel + content script wired up
- `background.js` — opens the side panel on icon click, relays messages
  between the panel and the content script (they can't talk directly)
- `sidepanel/` — the actual UI: paste prompts, set delay, start/pause/stop,
  see per-prompt status live
- `content-scripts/flow.js` — the automation logic *shape* (find input, set
  text, click generate, wait for result) with working React-input-setting
  logic, but placeholder selectors
- `icons/` — placeholder toolbar icons (swap for real branding later)

## Before Claude Code can finish this

The one real blocker: **we haven't inspected Flow's actual page yet.** Do
this first, in Chrome DevTools, on a live `labs.google/fx/...` project page:

1. **Prompt input** — right-click the prompt text field → Inspect. Note the
   tag (`textarea` vs `contenteditable div`), and any `aria-label`,
   `data-testid`, or `placeholder` attribute. Avoid relying on the class
   name — Flow is React and classes are likely generated/unstable.
2. **Generate button** — same treatment. Look for `aria-label` or visible
   text you can match on.
3. **Results container** — trigger one generation manually and watch the
   Elements panel for what changes when a result finishes. You want the
   parent element that gets a new child (image/video) appended, and what
   distinguishes a "finished" thumbnail from a "still loading" one (e.g. a
   loading spinner class that disappears, or an `<img>`'s `src` finally
   being non-empty).
4. **Copy 2–3 real example prompt submissions** and note the network
   requests in the Network tab (filter by Fetch/XHR) — even without a
   public API, seeing the request/response shape sometimes reveals a more
   reliable way to detect "done" than DOM-watching alone.

Bring those selectors (or just paste raw HTML snippets) into your Claude
Code session along with this repo, and the three `TODO`-marked functions in
`content-scripts/flow.js` — `findPromptInput`, `findGenerateButton`,
`waitForResult` — are what need to get filled in.

## Loading it locally (to test the shell now)

1. `chrome://extensions`
2. Enable "Developer mode" (top right)
3. "Load unpacked" → select this folder
4. Click the Overflow icon → side panel opens
5. It'll correctly report "No Flow tab found" until the content script
   selectors are real — that error path already works.

## Known open questions (not yet decided)

- **Download step**: once `waitForResult` returns a real asset URL, we still
  need to wire up `chrome.downloads.download()` — not built yet.
- **Rate limiting / detection risk**: no artificial delay randomization yet
  beyond the fixed per-prompt delay in the UI. Worth revisiting once the
  automation actually works, to avoid anything that looks bot-like.
- **Persistence**: prompt queue currently lives only in the side panel's
  JS memory — closing the panel loses progress. `chrome.storage.local` isn't
  wired in yet.
