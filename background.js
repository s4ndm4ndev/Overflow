// Overflow — background service worker
//
// Responsibilities:
//  1. Make the toolbar icon open the side panel (instead of a popup).
//  2. Relay messages between the side panel UI and the content script
//     running on the Flow page, since they can't talk to each other directly.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Simple message relay.
// Side panel sends: { target: "content", type: "...", payload: {...} }
// Content script sends: { target: "panel", type: "...", payload: {...} }
//
// We don't have a persistent connection to the side panel, so status updates
// from the content script get broadcast via chrome.runtime.sendMessage and
// the side panel listens for them directly. This relay mainly exists for
// panel -> content script commands, which need a specific tab ID.

const FLOW_ORIGIN_PATTERN = /^https:\/\/labs\.google\/fx\//;
// A real project looks like https://labs.google/fx/tools/flow/project/<id> —
// being somewhere under /fx/ (e.g. the tool landing page or project list)
// isn't enough; there has to be an actual project open.
const FLOW_PROJECT_PATTERN = /^https:\/\/labs\.google\/fx\/tools\/flow\/project\/[^/?#]+/;

/**
 * Dispatch one genuinely trusted mouse click at (x, y) in tab coordinates,
 * via the Chrome DevTools Protocol.
 *
 * Why this exists: Flow's Generate button ignores every synthetic trigger a
 * content script can produce on its own — confirmed live, plain `.click()`,
 * a full pointerdown/mousedown/pointerup/mouseup/click sequence, and even a
 * synthetic Enter keydown all silently did nothing. `chrome.debugger` is the
 * only thing that reproduced a click Flow actually acted on, most likely
 * because Flow deliberately gates this specific action (real compute cost
 * per click) behind `isTrusted` input as an anti-automation measure. Content
 * scripts can't use chrome.debugger at all, so this lives here; it attaches
 * only for the instant of the click and detaches immediately after, rather
 * than staying attached for the whole queue run.
 */
async function debuggerClick(tabId, x, y) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "background" && message.type === "DEBUGGER_CLICK") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id on sender." });
      return;
    }
    const { x, y } = message.payload;
    debuggerClick(tabId, x, y)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (message.target === "content") {
    // Forward the command only to the currently active tab in the focused
    // window, and only if that tab is actually an open Flow project. A Flow
    // tab sitting open in the background (unfocused window, not the active
    // tab, or on Flow but without a project open) should NOT count as
    // "detected" — otherwise the panel reports readiness when there's
    // nowhere for the content script to actually run.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0];
      const url = (tab && tab.url) || "";
      if (!FLOW_ORIGIN_PATTERN.test(url)) {
        sendResponse({ ok: false, error: "Flow tab is not active. Switch to the Flow project tab to continue." });
        return;
      }
      if (!FLOW_PROJECT_PATTERN.test(url)) {
        sendResponse({ ok: false, error: "Open a Flow project to continue — you're on Flow, but not inside a project." });
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        sendResponse(response);
      });
    });
    return true; // keep the message channel open for the async response
  }

  // Messages from content script (target: "panel") are just broadcast as-is;
  // the side panel's own onMessage listener picks them up. Nothing to do here.
});
