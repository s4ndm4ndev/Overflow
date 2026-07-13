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
 * The composer toolbar actually has four buttons (attach-media "+", "Agent",
 * a model picker, and the real submit arrow) — confirmed via live inspection.
 * The previous version of this function grabbed the *first* <button> found
 * while walking up from the input, which is the "+" attach button, not
 * submit; clicking it does nothing visible, which is why prompts appeared to
 * "submit" but never generated anything. Worse, the "+" button and the real
 * submit button share the exact same visually-hidden "Create" accessible
 * name, so matching on that label doesn't disambiguate them either. The
 * reliable identifier is the submit button's icon-font ligature
 * ("arrow_forward", a Google Material Symbols name — stable, unlike the
 * generated CSS classes).
 */
function findGenerateButton() {
  const input = findPromptInput();
  if (!input) return null;
  let container = input.parentElement;
  while (container) {
    const buttons = Array.from(container.querySelectorAll("button"));
    const submit = buttons.find((b) => {
      const icon = b.querySelector("i");
      return icon && icon.textContent.trim() === "arrow_forward";
    });
    if (submit) return submit;
    container = container.parentElement;
  }
  return null;
}

/**
 * Ask the main-world bridge script (content-scripts/flow-main-world.js) to
 * set the prompt text, and wait for its response.
 *
 * This can't be done directly from here: content scripts run in an
 * "isolated world" that does NOT see expando properties — like React's
 * __reactFiber$<hash> — that the page's own scripts attach to DOM nodes.
 * Confirmed via live diagnostics: reading that property from here returned
 * nothing, even though the identical check reliably found it every time
 * when run from the page's own console. The main-world script does the
 * actual Slate editor manipulation (see its comments for the full
 * reasoning); this just relays the request and response over
 * window.postMessage, since a MAIN-world script has no access to
 * chrome.runtime to reply any other way.
 */
function setPromptText(text) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random()}`;

    // Generous ceiling: the main-world script now types word-by-word with a
    // small per-word pause (see flow-main-world.js) rather than inserting
    // the whole prompt instantly, so long prompts legitimately take a few
    // seconds.
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for the prompt composer to update."));
    }, 30000);

    function onMessage(event) {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== "overflow-main-world" || message.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (message.ok) resolve();
      else reject(new Error(message.error || "Failed to set the prompt text."));
    }
    window.addEventListener("message", onMessage);

    window.postMessage({ source: "overflow-isolated", type: "SET_PROMPT_TEXT", requestId, text }, "*");
  });
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

function getFinishedTileIds(root) {
  return new Set(
    Array.from(root.querySelectorAll("[data-tile-id]"))
      .filter(tileHasFinished)
      .map((el) => el.getAttribute("data-tile-id"))
  );
}

/**
 * Watch for a tile transitioning into the finished state described above,
 * ignoring any tile that was already finished before this generation started.
 *
 * This used to require `[data-testid="virtuoso-item-list"]` (the results
 * gallery container seen while inspecting the "All Media" grid view) to
 * exist before watching at all. In practice Flow renders results differently
 * depending on which project view is active — e.g. a chat/agent-style
 * composer, as opposed to that grid — and that container isn't always
 * present, which surfaced as "Could not find the results gallery on the
 * page" even though generation was working fine. The per-tile completion
 * signal (a `data-tile-id` element gaining a finished edit link) is
 * unambiguous by itself, so watch the whole document instead of gating on
 * one specific container.
 */
function waitForResult(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const alreadyFinished = getFinishedTileIds(document);

    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for generation result."));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const newlyFinished = Array.from(document.querySelectorAll("[data-tile-id]")).find(
        (el) => !alreadyFinished.has(el.getAttribute("data-tile-id")) && tileHasFinished(el)
      );
      if (newlyFinished) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve(extractResult(newlyFinished));
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
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
 * Click the Generate button via a genuinely trusted click, dispatched from
 * background.js over the Chrome DevTools Protocol.
 *
 * Confirmed via live testing that this button ignores every synthetic
 * trigger a content script can produce on its own: plain `.click()`, a full
 * `pointerdown`/`mousedown`/`pointerup`/`mouseup`/`click` sequence, and even
 * a synthetic Enter keydown on the composer — all silently did nothing. The
 * most likely explanation is that Flow deliberately gates the actual
 * generate action behind `isTrusted` input, since it's a real compute cost
 * per click — a reasonable anti-automation measure. `chrome.debugger` is the
 * only thing that reproduced a click Flow actually acted on, so it's used
 * here for just this one step (attach, one click, detach immediately) rather
 * than for the whole interaction.
 */
async function clickGenerateButton(btn) {
  const rect = btn.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "background", type: "DEBUGGER_CLICK", payload: { x, y } }, resolve);
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "Failed to click the Generate button.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single prompt end-to-end: fill it in, click generate, wait for result.
 */
async function runPrompt(text) {
  const input = findPromptInput();
  if (!input) throw new Error("Could not find the prompt input on the page.");
  await setPromptText(text);

  const btn = findGenerateButton();
  if (!btn) throw new Error("Could not find the Generate button.");
  const enabled = await waitForButtonEnabled(btn);
  if (!enabled) throw new Error("Generate button stayed disabled after entering the prompt.");

  // The text lands and the button enables in a single tick — instant,
  // machine-speed, back-to-back with filling the composer. Add a short
  // randomized pause here, as if someone typed the prompt and glanced over
  // it before hitting generate, rather than clicking the literal instant
  // the field allows it.
  await sleep(600 + Math.random() * 1200);
  await clickGenerateButton(btn);

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
