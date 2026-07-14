// Overflow — background service worker
//
// Responsibilities:
//  1. Make the toolbar icon open the side panel (instead of a popup).
//  2. Relay messages between the side panel UI and the content script
//     running on the Flow page, since they can't talk to each other directly.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// FIFO queue of { folder, baseIndex } for downloads WE just started via
// DOWNLOAD_RESULT below, consumed by onDeterminingFilename. The queue (not a
// downloadId-keyed map) exists because the side panel's download() callback
// hands back a downloadId, but nothing guarantees that callback fires before
// onDeterminingFilename does for the same download — pushing onto this queue
// synchronously, right before calling chrome.downloads.download(), sidesteps
// that ordering question entirely. Safe because the queue only ever
// processes one of our own downloads at a time.
const pendingDownloadNames = [];

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/**
 * Pick a file extension for a completed download. Prefer the real
 * Content-Type Chrome detected (downloadItem.mime) over guessing ahead of
 * time — Flow serves generated images as image/jpeg, not the .png this
 * extension used to assume.
 */
function extensionFromDownloadItem(item) {
  if (item.mime && MIME_EXT[item.mime]) return MIME_EXT[item.mime];
  const match = /\.([a-z0-9]{2,4})$/i.exec(item.filename || "");
  if (match) return match[1].toLowerCase();
  return "jpg";
}

/**
 * The authoritative place to control a download's destination filename.
 * Passing `filename` directly to chrome.downloads.download() was confirmed
 * live to silently lose both the subfolder and the zero-padded name for
 * Flow's result URLs — the file landed in the default Downloads folder,
 * named after Flow's own asset UUID instead. onDeterminingFilename always
 * wins, so it's used here instead.
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const pending = pendingDownloadNames.shift();
  if (!pending) {
    suggest();
    return;
  }
  const ext = extensionFromDownloadItem(item);
  const name = `${pending.baseIndex}.${ext}`;
  suggest({ filename: pending.folder ? `${pending.folder}/${name}` : name, conflictAction: "uniquify" });
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
 * Resolve the active tab of the focused window to a usable Flow project tab,
 * or a specific reason it isn't one. Shared by the "content" relay below and
 * the tab-refresh handler, so both apply the exact same "is this actually
 * usable" rule.
 */
function findActiveFlowProjectTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0];
      const url = (tab && tab.url) || "";
      if (!FLOW_ORIGIN_PATTERN.test(url)) {
        resolve({ tab: null, error: "Flow tab is not active. Switch to the Flow project tab to continue." });
        return;
      }
      if (!FLOW_PROJECT_PATTERN.test(url)) {
        resolve({ tab: null, error: "Open a Flow project to continue — you're on Flow, but not inside a project." });
        return;
      }
      resolve({ tab, error: null });
    });
  });
}

/**
 * Reload a tab and wait for it to actually be usable, rather than just
 * firing chrome.tabs.reload() and guessing. "complete" (the tab's load
 * event) only means the network/resources finished — Flow's React app can
 * take noticeably longer than that to actually mount the composer.
 * Confirmed live: a fixed ~800ms buffer after "complete" wasn't consistently
 * enough, so the first queued prompt after Start would run against a
 * composer that didn't exist yet (error), only for the next one to succeed
 * once the app had caught up. Fixed by polling the (freshly re-injected)
 * content script's own composerReady signal after "complete" fires, instead
 * of trusting a fixed delay.
 */
function reloadTabAndWait(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const start = Date.now();

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for the Flow tab to finish reloading."));
    }, timeoutMs);

    function pollComposerReady() {
      if (done) return;
      chrome.tabs.sendMessage(tabId, { target: "content", type: "PING" }, (response) => {
        void chrome.runtime.lastError; // content script not injected yet right after reload — expected, ignore
        if (done) return;
        if (response && response.ok && response.composerReady) {
          done = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          done = true;
          clearTimeout(timeout);
          reject(new Error("Flow's page took too long to become ready after reloading."));
          return;
        }
        setTimeout(pollComposerReady, 300);
      });
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete" || done) return;
      chrome.tabs.onUpdated.removeListener(listener);
      pollComposerReady();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

/**
 * Dispatch one genuinely trusted mouse click at (x, y) in tab coordinates,
 * via the Chrome DevTools Protocol — split into separate attach / click /
 * detach steps (see the message handlers below for why).
 *
 * Why this exists at all: Flow's Generate button ignores every synthetic
 * trigger a content script can produce on its own — confirmed live, plain
 * `.click()`, a full pointerdown/mousedown/pointerup/mouseup/click sequence,
 * and even a synthetic Enter keydown all silently did nothing.
 * `chrome.debugger` is the only thing that reproduced a click Flow actually
 * acted on, most likely because Flow deliberately gates this specific action
 * (real compute cost per click) behind `isTrusted` input as an
 * anti-automation measure. Content scripts can't use chrome.debugger at all,
 * so this lives here.
 */
async function debuggerAttach(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
}

async function debuggerDetach(tabId) {
  await chrome.debugger.detach({ tabId });
}

async function debuggerDispatchClick(tabId, x, y) {
  const target = { tabId };
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
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "background" && message.type === "DEBUGGER_ATTACH") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id on sender." });
      return;
    }
    debuggerAttach(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (message.target === "background" && message.type === "DEBUGGER_CLICK") {
    // Attach already happened in a prior DEBUGGER_ATTACH round-trip, and the
    // caller measured click coordinates AFTER that attach completed. Doing
    // it in that order matters: attaching triggers Chrome's "is debugging
    // this browser" infobar, which visibly reflows the whole page down by
    // its own height (confirmed live by comparing screenshots before/after
    // it appears). Coordinates measured before attach — i.e. before that
    // reflow — end up pointing ~30-40px above the button's real position
    // once the banner has actually pushed everything down, so the click
    // silently lands on nothing. Measuring after attach avoids that.
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id on sender." });
      return;
    }
    const { x, y } = message.payload;
    debuggerDispatchClick(tabId, x, y)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (message.target === "background" && message.type === "DEBUGGER_DETACH") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id on sender." });
      return;
    }
    debuggerDetach(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (message.target === "background" && message.type === "DOWNLOAD_RESULT") {
    const { url, folder, baseIndex } = message.payload;
    if (!url) {
      sendResponse({ ok: false, error: "No result URL." });
      return;
    }
    const entry = { folder, baseIndex };
    pendingDownloadNames.push(entry);
    chrome.downloads.download({ url, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        // This download never actually started, so it will never reach
        // onDeterminingFilename to consume its queued entry — drop it now,
        // or it would get wrongly applied to some later, unrelated download.
        const idx = pendingDownloadNames.indexOf(entry);
        if (idx !== -1) pendingDownloadNames.splice(idx, 1);
        sendResponse({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Download failed to start." });
        return;
      }
      sendResponse({ ok: true, downloadId });
    });
    return true; // async response
  }

  if (message.target === "background" && message.type === "REFRESH_FLOW_TAB") {
    findActiveFlowProjectTab().then(({ tab, error }) => {
      if (!tab) {
        sendResponse({ ok: false, error });
        return;
      }
      reloadTabAndWait(tab.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true; // async response
  }

  if (message.target === "content") {
    // Forward the command only to the currently active tab in the focused
    // window, and only if that tab is actually an open Flow project. A Flow
    // tab sitting open in the background (unfocused window, not the active
    // tab, or on Flow but without a project open) should NOT count as
    // "detected" — otherwise the panel reports readiness when there's
    // nowhere for the content script to actually run.
    findActiveFlowProjectTab().then(({ tab, error }) => {
      if (!tab) {
        sendResponse({ ok: false, error });
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

/**
 * Notify the side panel whenever the Flow project tab's "visible, active
 * tab" status changes, so the panel can auto-pause the queue while it's
 * away — Chrome throttles timers in tabs that aren't the active tab of a
 * window, and a long-running queue left generating against a throttled
 * background tab can silently stall or misbehave. Only broadcasts on actual
 * transitions (not every check) so the panel isn't spammed on every
 * unrelated tab switch.
 */
let lastReportedFlowFocused = null;

function checkAndBroadcastFocusState() {
  findActiveFlowProjectTab().then(({ tab }) => {
    const focused = !!tab;
    if (focused === lastReportedFlowFocused) return;
    lastReportedFlowFocused = focused;
    chrome.runtime.sendMessage({ target: "panel", type: "FLOW_FOCUS_CHANGED", payload: { focused } });
  });
}

chrome.tabs.onActivated.addListener(() => {
  checkAndBroadcastFocusState();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE means focus left every Chrome window entirely (switched
  // to another app, or Chrome was minimized) — lastFocusedWindow-based
  // queries wouldn't reliably reflect that (it keeps remembering the last
  // Chrome window that had focus), so treat it as unfocused directly rather
  // than re-querying.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (lastReportedFlowFocused !== false) {
      lastReportedFlowFocused = false;
      chrome.runtime.sendMessage({ target: "panel", type: "FLOW_FOCUS_CHANGED", payload: { focused: false } });
    }
    return;
  }
  checkAndBroadcastFocusState();
});
