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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "content") {
    // Find the active Flow tab and forward the command to its content script.
    chrome.tabs.query({ url: "https://labs.google/fx/*" }, (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ ok: false, error: "No Flow tab found. Open a Flow project first." });
        return;
      }
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, message, (response) => {
        sendResponse(response);
      });
    });
    return true; // keep the message channel open for the async response
  }

  // Messages from content script (target: "panel") are just broadcast as-is;
  // the side panel's own onMessage listener picks them up. Nothing to do here.
});
