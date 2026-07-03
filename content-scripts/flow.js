// Overflow — content script (runs on labs.google/fx/*)
//
// This file is a SKELETON. The functions below are stubbed with the
// interface the rest of the extension expects, but the actual DOM
// selectors are NOT filled in yet — that requires inspecting the live
// Flow page in DevTools first (see README.md, "Before Claude Code can
// finish this").
//
// Flow is a React app, so two things matter for every function here:
//   1. Selectors WILL be unstable/obfuscated (e.g. class="css-a1b2c3").
//      Prefer stable attributes: aria-label, data-testid, placeholder text,
//      role, or the accessible name of the element — anything NOT tied to
//      a generated CSS class.
//   2. You cannot just do `input.value = "..."` — React tracks input state
//      internally and won't "see" a plain value assignment. You have to set
//      the value via the native input value setter and then dispatch a real
//      'input' event, so React's onChange handler fires. See setPromptText()
//      below for the pattern.

/**
 * Find the prompt composer on the page.
 * This is a Slate.js rich-text editor, not a <textarea> — confirmed via
 * live inspection. `data-slate-editor` is an attribute Slate itself adds
 * to the DOM (not a generated class), so it's stable across Flow's builds.
 */
function findPromptInput() {
  return document.querySelector('[data-slate-editor="true"][role="textbox"]');
}

/**
 * Find the submit button next to the prompt composer.
 * Flow's button currently has the accessible name "Create" (in a visually-
 * hidden span) plus an icon-font ligature — not "Generate", and matching on
 * that label is risky anyway since it already differs from what the spec
 * assumed and could change again. Instead, walk up from the prompt input to
 * the nearest ancestor that also contains a <button>: that's the shared
 * composer toolbar, regardless of what the button is labeled.
 */
function findGenerateButton() {
  const input = findPromptInput();
  if (!input) return null;
  let container = input.parentElement;
  while (container) {
    const button = container.querySelector("button");
    if (button) return button;
    container = container.parentElement;
  }
  return null;
}

/**
 * Set the prompt text in a way Slate will actually register.
 * Slate manages its own internal document model and only reacts to real
 * `beforeinput` events (via its DOM event listeners) — plain textContent
 * assignment or a synthetic `input` event dispatch is invisible to it.
 * `execCommand("insertText", ...)` is the standard trick for this: it
 * drives the same native insertion pipeline as actual typing/pasting, so
 * Slate's beforeinput handler picks it up correctly.
 */
function setPromptText(inputEl, text) {
  inputEl.focus();
  const range = document.createRange();
  range.selectNodeContents(inputEl);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("insertText", false, text);
}

function isButtonDisabled(btn) {
  return btn.disabled || btn.getAttribute("aria-disabled") === "true";
}

/**
 * The submit button starts aria-disabled until Flow's React state notices
 * the composer has text, which may lag a tick behind the input event —
 * poll briefly instead of assuming it's already enabled.
 */
function waitForButtonEnabled(btn, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!isButtonDisabled(btn)) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      if (!isButtonDisabled(btn)) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 50);
  });
}

/**
 * A tile counts as finished once it has a link into its own edit page
 * (`href` containing "/edit/<asset-id>"). Confirmed via live inspection of
 * the SAME tile-id at two points in time: while generating, its wrapper div
 * has inline style `opacity: 0; --blur-amount: 80px` (blurred placeholder)
 * and no such link; once done, that becomes `opacity: 1; --blur-amount: 0px`
 * and the edit link appears. The tile DOM node itself exists immediately
 * when generation starts (not just once finished), so tile *creation* is
 * NOT a valid completion signal — only the edit link is.
 */
function tileHasFinished(tileEl) {
  return !!tileEl.querySelector('a[href*="/edit/"]');
}

function getFinishedTileIds(container) {
  return new Set(
    Array.from(container.querySelectorAll("[data-tile-id]"))
      .filter(tileHasFinished)
      .map((el) => el.getAttribute("data-tile-id"))
  );
}

/**
 * Watch the results gallery for a tile transitioning into the finished
 * state described above, ignoring any tile that was already finished
 * before this generation started.
 */
function waitForResult(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const container = document.querySelector('[data-testid="virtuoso-item-list"]');
    if (!container) {
      reject(new Error("Could not find the results gallery on the page."));
      return;
    }

    const alreadyFinished = getFinishedTileIds(container);

    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for generation result."));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const newlyFinished = Array.from(container.querySelectorAll("[data-tile-id]")).find(
        (el) => !alreadyFinished.has(el.getAttribute("data-tile-id")) && tileHasFinished(el)
      );
      if (newlyFinished) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve(extractResult(newlyFinished));
      }
    });

    observer.observe(container, { childList: true, subtree: true, attributes: true });
  });
}

/**
 * Pull the downloadable URL out of a finished tile.
 *
 * Confirmed via live inspection: the asset is a plain same-origin URL
 * (`/fxapi/trpc/media.getMediaUrlRedirect?name=<id>`) rendered straight into
 * an <img> (or presumably <video>) tag — NOT a page-scoped `blob:` URL, which
 * was the original assumption before inspecting the real DOM. That means
 * `chrome.downloads.download()` can fetch it directly using the browser's
 * own cookies; there's no need to fetch the bytes here and smuggle them
 * through chrome.runtime messaging as a data: URL.
 */
function extractResult(tileEl) {
  const media = tileEl.querySelector("img, video");
  if (!media) return { url: null, tileId: tileEl.getAttribute("data-tile-id") };
  return {
    url: media.currentSrc || media.src,
    mediaType: media.tagName.toLowerCase(), // "img" or "video"
    tileId: tileEl.getAttribute("data-tile-id"),
  };
}

/**
 * Run a single prompt end-to-end: fill it in, click generate, wait for result.
 */
async function runPrompt(text) {
  const input = findPromptInput();
  if (!input) throw new Error("Could not find the prompt input on the page.");
  setPromptText(input, text);

  const btn = findGenerateButton();
  if (!btn) throw new Error("Could not find the Generate button.");
  const enabled = await waitForButtonEnabled(btn);
  if (!enabled) throw new Error("Generate button stayed disabled after entering the prompt.");
  btn.click();

  return waitForResult();
}

// Listen for commands from the side panel (relayed via background.js).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "content") return;

  if (message.type === "PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "RUN_PROMPT") {
    runPrompt(message.payload.text)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
});
