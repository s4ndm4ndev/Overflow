// Overflow — main-world bridge (runs on labs.google/fx/*)
//
// This script exists solely because content scripts run in an "isolated
// world" by default, which does NOT see expando properties — like React's
// __reactFiber$<hash> — that the page's own main-world scripts attach to
// DOM nodes. Confirmed via live diagnostics: the exact same fiber-walk that
// reliably found Slate's editor object when run from the page's real
// console (main world) found nothing at all when run from
// content-scripts/flow.js (isolated world) — Object.keys(inputEl) didn't
// even enumerate the __reactFiber$ key there.
//
// This script runs in the MAIN world instead (see manifest.json's "world":
// "MAIN" entry for it) so it can actually see React's internals — but it
// has NO access to chrome.* APIs from there, so it only does the DOM/React
// work and relays request/response back to the isolated-world content
// script via window.postMessage.

function findSlateEditor(inputEl) {
  const fiberKey = Object.keys(inputEl).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) return null;

  const looksLikeSlateEditor = (obj) =>
    obj && typeof obj === "object" && Array.isArray(obj.children) && typeof obj.apply === "function" && typeof obj.onChange === "function";

  let fiber = inputEl[fiberKey];
  const seen = new Set();
  while (fiber && !seen.has(fiber)) {
    seen.add(fiber);
    const props = fiber.memoizedProps;
    if (props) {
      const match = Object.keys(props).find((key) => looksLikeSlateEditor(props[key]));
      if (match) return props[match];
    }
    fiber = fiber.return;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tracks the most recent SET_PROMPT_TEXT request. The isolated-world side
// times out and gives up on a request after 30s (see setPromptText() in
// flow.js), but nothing was stopping THIS loop from continuing to run after
// that — confirmed live: typing kept visibly happening well after the queue
// had already reported prompts as errored. If the queue then moved on to the
// next prompt while an old, abandoned loop was still mid-typing, both loops
// would call editor.insertText() on the same document concurrently,
// corrupting whatever the composer ends up containing. Every await point
// below re-checks this against the request's own id and bails out silently
// (no postMessage back — nothing is listening for a superseded request
// anyway) the moment a newer request has taken over.
let activeRequestId = null;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== "overflow-isolated" || message.type !== "SET_PROMPT_TEXT") return;

  const requestId = message.requestId;
  activeRequestId = requestId;

  (async () => {
    let result;
    try {
      const inputEl = document.querySelector('[data-slate-editor="true"][role="textbox"]');
      if (!inputEl) throw new Error("Could not find the prompt input on the page.");
      const editor = findSlateEditor(inputEl);
      if (!editor) throw new Error("Could not reach Slate's editor instance for the prompt composer.");

      // Clear the composer, then type word-by-word with a short randomized
      // pause between words instead of dropping the whole prompt in as one
      // instant edit — the first version filled and submitted a prompt in a
      // single tick, which reads as obviously machine-speed.
      editor.select({ anchor: editor.start([]), focus: editor.end([]) });
      const words = message.text.split(" ");
      for (let i = 0; i < words.length; i++) {
        if (activeRequestId !== requestId) return; // superseded — abandon without touching the editor further
        editor.insertText((i === 0 ? "" : " ") + words[i]);
        await sleep(160 + Math.random() * 220);
      }
      if (activeRequestId !== requestId) return;

      result = { ok: true };
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    if (activeRequestId === requestId) {
      window.postMessage({ source: "overflow-main-world", requestId: message.requestId, ...result }, "*");
    }
  })();
});
