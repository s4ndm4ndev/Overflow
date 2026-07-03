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
 * Find the prompt textarea/input on the page.
 * TODO: inspect the real page and replace this selector.
 * Look for: a <textarea> or contenteditable div, likely with a
 * placeholder like "Describe your image..." — check aria-label first.
 */
function findPromptInput() {
  // Placeholder guess — almost certainly wrong, needs real inspection.
  return document.querySelector('textarea[aria-label*="prompt" i], textarea[placeholder]');
}

/**
 * Find the "Generate" button.
 * TODO: inspect the real page. Look for a <button> with an accessible
 * name of "Generate" (check aria-label or visible text), not a CSS class.
 */
function findGenerateButton() {
  const buttons = Array.from(document.querySelectorAll("button"));
  return buttons.find((b) => /generate/i.test(b.textContent || b.getAttribute("aria-label") || ""));
}

/**
 * Set the prompt text in a way React will actually register.
 * This part is NOT a guess — this pattern is required for any React-
 * controlled input, regardless of what Flow's specific selectors turn
 * out to be. Keep this as-is.
 */
function setPromptText(inputEl, text) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  nativeSetter.call(inputEl, text);
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Click generate.
 */
function clickGenerate() {
  const btn = findGenerateButton();
  if (!btn) return false;
  btn.click();
  return true;
}

/**
 * Watch the page for a newly-finished generation (new thumbnail/result
 * appearing), and resolve with info about it.
 * TODO: this needs the real container selector for the results gallery,
 * found by inspecting the page while a generation completes.
 */
function waitForResult(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for generation result."));
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      // TODO: replace with a real check — e.g. a new <img> or <video>
      // appearing inside the results gallery container.
      const done = false; // placeholder
      if (done) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve({ url: null }); // TODO: extract the actual asset URL
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Run a single prompt end-to-end: fill it in, click generate, wait for result.
 */
async function runPrompt(text) {
  const input = findPromptInput();
  if (!input) throw new Error("Could not find the prompt input on the page.");
  setPromptText(input, text);

  const clicked = clickGenerate();
  if (!clicked) throw new Error("Could not find or click the Generate button.");

  const result = await waitForResult();
  return result;
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
