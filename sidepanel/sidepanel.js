// Overflow — side panel logic
//
// Owns the queue state and drives it forward one prompt at a time,
// sending each prompt to the content script via background.js and
// waiting for the result before moving on.

const promptsEl = document.getElementById("prompts");
const promptFileEl = document.getElementById("prompt-file");
const consistentCharacterToggleEl = document.getElementById("consistent-character-toggle");
const consistentCharacterPanelEl = document.getElementById("consistent-character-panel");
const characterDropzoneEl = document.getElementById("character-dropzone");
const characterFileInputEl = document.getElementById("character-file-input");
const characterListEl = document.getElementById("character-list");
const delayMinEl = document.getElementById("delay-min");
const delayMaxEl = document.getElementById("delay-max");
const autoDownloadEl = document.getElementById("auto-download");
const downloadSettingsHintEl = document.getElementById("download-settings-hint");
const openDownloadSettingsBtn = document.getElementById("open-download-settings");
const downloadFolderEl = document.getElementById("download-folder");
const startBtn = document.getElementById("start");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const clearBtn = document.getElementById("clear");
const queueListEl = document.getElementById("queue-list");
const queueProgressEl = document.getElementById("queue-progress");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const blockingOverlayEl = document.getElementById("blocking-overlay");
const blockingTitleEl = document.getElementById("blocking-title");
const blockingMessageEl = document.getElementById("blocking-message");
const blockingActionEl = document.getElementById("blocking-action");
const tabButtons = document.querySelectorAll(".tab-button");
const controlsViewEl = document.getElementById("controls-view");
const aboutViewEl = document.getElementById("about-view");
const aboutVersionEl = document.getElementById("about-version");
const aboutWebsiteLinkEl = document.getElementById("about-website-link");

const FLOW_TOOL_URL = "https://labs.google/fx/tools/flow";
const AUTHOR_WEBSITE_URL = "https://s4ndm4n.dev/";

let queue = [];       // [{ text, status, matchedImages: [{id, characterName}] }]
let currentIndex = -1;
let running = false;
let paused = false;
// Auto-pause driven by background.js's FLOW_FOCUS_CHANGED, distinct from the
// user-controlled `paused` flag above so a manual pause isn't silently
// cleared by regaining focus, and so a focus-driven pause doesn't flip the
// Pause/Resume button's own state. The wait loops in delayWithCountdown()
// and runQueue() block on either flag.
let focusPaused = false;

// Consistent Character feature — in-memory cache of uploaded character
// records (kept in sync with IndexedDB via character-store.js) plus a
// Map<id, objectURL> reused for both the upload panel's thumbnails and the
// per-queue-item thumbnails in renderQueue(), so re-rendering the queue on
// every status change never has to re-read IndexedDB.
const SETTINGS_KEY = "overflow_settings";
let characterRecords = []; // [{ id, characterName, fileName, mimeType, addedAt }]
const characterThumbUrls = new Map();

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => resolve(result[SETTINGS_KEY] || {}));
  });
}

function saveSettings(partial) {
  loadSettings().then((current) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...partial } });
  });
}

async function refreshCharacterRecords() {
  characterRecords = await CharacterStore.listCharacterImages();

  const currentIds = new Set(characterRecords.map((r) => r.id));
  for (const [id, url] of characterThumbUrls) {
    if (!currentIds.has(id)) {
      URL.revokeObjectURL(url);
      characterThumbUrls.delete(id);
    }
  }

  await Promise.all(
    characterRecords
      .filter((r) => !characterThumbUrls.has(r.id))
      .map(async (r) => {
        const blob = await CharacterStore.getCharacterImageBlob(r.id);
        if (blob) characterThumbUrls.set(r.id, URL.createObjectURL(blob));
      })
  );

  renderCharacterList();
}

function renderCharacterList() {
  characterListEl.innerHTML = "";
  characterRecords.forEach((record) => {
    const li = document.createElement("li");

    const img = document.createElement("img");
    img.className = "character-thumb";
    img.src = characterThumbUrls.get(record.id) || "";
    img.alt = record.characterName;

    const name = document.createElement("span");
    name.className = "character-name";
    name.textContent = record.characterName;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "character-remove";
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${record.characterName}`;
    removeBtn.addEventListener("click", () => removeCharacterImage(record.id));

    li.appendChild(img);
    li.appendChild(name);
    li.appendChild(removeBtn);
    characterListEl.appendChild(li);
  });
}

async function removeCharacterImage(id) {
  await CharacterStore.removeCharacterImage(id);
  await refreshCharacterRecords();
}

async function addCharacterFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  for (const file of files) {
    await CharacterStore.addCharacterImage(file);
  }
  if (files.length > 0) await refreshCharacterRecords();
}

consistentCharacterToggleEl.addEventListener("change", () => {
  consistentCharacterPanelEl.hidden = !consistentCharacterToggleEl.checked;
  saveSettings({ consistentCharacterEnabled: consistentCharacterToggleEl.checked });
  if (consistentCharacterToggleEl.checked) refreshCharacterRecords();
});

characterDropzoneEl.addEventListener("click", () => characterFileInputEl.click());

characterDropzoneEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  characterDropzoneEl.classList.add("dragover");
});

characterDropzoneEl.addEventListener("dragleave", () => {
  characterDropzoneEl.classList.remove("dragover");
});

characterDropzoneEl.addEventListener("drop", (e) => {
  e.preventDefault();
  characterDropzoneEl.classList.remove("dragover");
  addCharacterFiles(e.dataTransfer.files);
});

characterFileInputEl.addEventListener("change", () => {
  addCharacterFiles(characterFileInputEl.files);
  characterFileInputEl.value = ""; // allow re-selecting the same file later
});

// Restore the toggle + upload panel's persisted state on open (the first
// real use of chrome.storage.local in this codebase — see README's
// persistence gap note). The panel itself only becomes visible once the
// toggle is on, per the existing hidden-attribute pattern used elsewhere
// in this file (e.g. #download-settings-hint).
loadSettings().then((settings) => {
  consistentCharacterToggleEl.checked = !!settings.consistentCharacterEnabled;
  consistentCharacterPanelEl.hidden = !consistentCharacterToggleEl.checked;
  if (consistentCharacterToggleEl.checked) refreshCharacterRecords();
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read an image."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Resolve a queued item's matched character ids into the actual image data
 * needed by flow.js's attachCharacterImage() — a data URL (since content
 * scripts can't reach the side panel's IndexedDB directly) plus the
 * original fileName (Flow echoes it back verbatim in its asset picker,
 * which is how attachCharacterImage() finds the right uploaded asset among
 * possibly several character images).
 */
async function resolveQueueImages(item) {
  if (!item.matchedImages || item.matchedImages.length === 0) return [];
  const images = [];
  for (const match of item.matchedImages) {
    const blob = await CharacterStore.getCharacterImageBlob(match.id);
    if (!blob) continue;
    const record = characterRecords.find((r) => r.id === match.id);
    images.push({
      characterName: match.characterName,
      mimeType: blob.type,
      dataUrl: await blobToDataUrl(blob),
      fileName: (record && record.fileName) || `${match.characterName}.png`,
    });
  }
  return images;
}

function setStatus(text, mode = "idle") {
  statusText.textContent = text;
  statusDot.className = `dot ${mode}`;
}

const STATUS_LABELS = {
  pending: "Pending",
  running: "Generating…",
  done: "Done ✓",
  error: "Error",
};

function updateClearButton() {
  clearBtn.disabled = running || queue.length === 0;
}

function renderQueue() {
  queueListEl.innerHTML = "";
  queue.forEach((item) => {
    const li = document.createElement("li");
    if (item.status === "running") li.classList.add("active");
    const dot = document.createElement("span");
    dot.className = `status-dot ${item.status}`;
    const text = document.createElement("span");
    text.className = "item-text";
    text.textContent = item.text;
    li.appendChild(dot);
    li.appendChild(text);

    if (item.matchedImages && item.matchedImages.length > 0) {
      const thumbs = document.createElement("span");
      thumbs.className = "item-thumbs";
      item.matchedImages.forEach((match) => {
        const url = characterThumbUrls.get(match.id);
        if (!url) return;
        const img = document.createElement("img");
        img.className = "item-thumb-img";
        img.src = url;
        img.title = match.characterName;
        thumbs.appendChild(img);
      });
      li.appendChild(thumbs);
    }

    const badge = document.createElement("span");
    badge.className = `status-badge ${item.status}`;
    badge.textContent = STATUS_LABELS[item.status] || item.status;
    li.appendChild(badge);
    queueListEl.appendChild(li);
  });
  const done = queue.filter((q) => q.status === "done").length;
  queueProgressEl.textContent = `${done} / ${queue.length}`;
  updateClearButton();
}

/**
 * Strip characters that are invalid in Windows/Unix file paths so a
 * user-supplied folder name is safe to pass into chrome.downloads.download().
 */
function sanitizeFolderName(name) {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/^\.+/, "")
    .replace(/-+$/, "")
    .slice(0, 60);
}

promptFileEl.addEventListener("change", () => {
  const file = promptFileEl.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    // Just normalize line endings — don't drop blank lines. Actual
    // queue-building (on Start) already ignores blank lines on its own, so
    // stripping them here served no functional purpose, only destroyed
    // whatever paragraph spacing the source file had between prompts.
    promptsEl.value = String(reader.result).replace(/\r\n/g, "\n");
  };
  reader.readAsText(file);
  promptFileEl.value = ""; // allow re-selecting the same file later
});

/**
 * Ask the background service worker to download a completed result, named
 * "{index}.{ext}" (zero-padded, e.g. "001.jpg") inside the optional
 * user-supplied subfolder. No-ops if there's no result URL.
 *
 * The actual filename is applied in background.js via
 * chrome.downloads.onDeterminingFilename rather than the `filename` option
 * on chrome.downloads.download() itself — passing it directly there was
 * confirmed live to silently lose both the subfolder and the zero-padded
 * name (files landed straight in the default Downloads folder, named after
 * Flow's own asset UUID instead). onDeterminingFilename is the API's actual
 * authoritative override point, and it also hands us the real Content-Type,
 * so background.js can pick the correct extension instead of guessing one
 * ahead of time (Flow serves images as .jpg, not the .png this used to
 * assume).
 *
 * There's no extension API to read Chrome's "Ask where to save each file"
 * setting, and if it's on, Chrome shows a native Save-As dialog per
 * download regardless of the saveAs:false passed here — chrome.downloads
 * .download()'s callback then won't fire until the user responds to it,
 * which would otherwise stall the entire queue indefinitely on the first
 * download. Give it a window to complete normally, then move on rather than
 * hang forever.
 */
function downloadResult(resultData, index) {
  return new Promise((resolve) => {
    if (!resultData || !resultData.url) {
      resolve();
      return;
    }

    const baseIndex = String(index + 1).padStart(3, "0");
    const folder = sanitizeFolderName(downloadFolderEl.value);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      setStatus(
        'Download is waiting on a Save dialog — check for it, or disable "Ask where to save each file" in Chrome\'s downloads settings.',
        "error"
      );
      settle();
    }, 8000);

    chrome.runtime.sendMessage(
      { target: "background", type: "DOWNLOAD_RESULT", payload: { url: resultData.url, folder, baseIndex } },
      (response) => {
        clearTimeout(timeout);
        if (!response || !response.ok) {
          setStatus(`Download failed: ${(response && response.error) || "no response from background"}`, "error");
        }
        settle();
      }
    );
  });
}

autoDownloadEl.addEventListener("change", () => {
  downloadSettingsHintEl.hidden = !autoDownloadEl.checked;
  downloadFolderEl.disabled = !autoDownloadEl.checked;
});

openDownloadSettingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.toggle("active", b === button));
    const showAbout = button.dataset.tab === "about";
    controlsViewEl.hidden = showAbout;
    aboutViewEl.hidden = !showAbout;
  });
});

aboutVersionEl.textContent = chrome.runtime.getManifest().version;

aboutWebsiteLinkEl.addEventListener("click", () => {
  chrome.tabs.create({ url: AUTHOR_WEBSITE_URL });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToContent(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "content", type, payload }, (response) => {
      resolve(response || { ok: false, error: "No response — is a Flow tab open?" });
    });
  });
}

function refreshFlowTab() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "background", type: "REFRESH_FLOW_TAB" }, (response) => {
      resolve(response || { ok: false, error: "No response from background script." });
    });
  });
}

/**
 * Full-panel modal that blocks every control underneath it — not just a
 * status message — for states where automation genuinely cannot proceed:
 * not on a Flow project, or Flow's "Agent" composer mode is on (a different
 * interaction model this automation was never built against). Forcing the
 * user to actually resolve the problem, rather than letting them fumble
 * with Start while the panel silently can't do anything, doubles as the
 * anti-throttling measure requested alongside this — it keeps the Flow tab
 * as the one thing on screen worth looking at.
 */
function showBlockingOverlay(reason, message) {
  if (reason === "not-on-flow") {
    blockingTitleEl.textContent = "Not on a Flow Project Page";
    blockingMessageEl.textContent = message || "The Flow Automation tool only works when you're on a Flow project page.";
    blockingActionEl.textContent = "Navigate to Flow";
    blockingActionEl.hidden = false;
    blockingActionEl.onclick = () => chrome.tabs.create({ url: FLOW_TOOL_URL });
  } else if (reason === "agent-mode") {
    blockingTitleEl.textContent = "Agent Mode Is On";
    blockingMessageEl.textContent = "Turn off Flow's Agent mode to use Overflow — this automation isn't built for that interaction model.";
    blockingActionEl.hidden = true;
  }
  blockingOverlayEl.hidden = false;
}

function hideBlockingOverlay() {
  blockingOverlayEl.hidden = true;
}

/**
 * Poll for a live, ready Flow tab so the status bar (and the blocking
 * overlay) reflect reality instead of a static placeholder. Skipped while a
 * queue is running so it doesn't clobber the in-progress status text — the
 * overlay would otherwise physically prevent the running queue's own
 * Pause/Stop controls from being clicked.
 */
async function checkFlowTab() {
  if (running) return;
  const ping = await sendToContent("PING");
  if (!ping.ok) {
    setStatus(ping.error || "No Flow tab found — open a Flow project tab.", "error");
    showBlockingOverlay("not-on-flow", ping.error);
    return;
  }
  if (ping.agentModeOn) {
    setStatus("Agent mode is on — turn it off in Flow to continue.", "error");
    showBlockingOverlay("agent-mode");
    return;
  }
  setStatus("Flow tab detected — ready to start.", "idle");
  hideBlockingOverlay();
}

// Best-effort refresh once when the panel first opens, so automation always
// starts from a clean page load rather than a Flow tab that's been sitting
// open accumulating state. Silent on failure — the paired tab may
// legitimately not be on Flow yet at this point, and checkFlowTab()'s own
// polling (below) already surfaces that clearly via the blocking overlay.
refreshFlowTab();

checkFlowTab();
setInterval(checkFlowTab, 3000);

/**
 * Wait the configured (randomized) delay before the next prompt, ticking
 * the status text down every second so the pause is actually visible
 * instead of looking like nothing is happening between prompts.
 */
async function delayWithCountdown() {
  let minSec = Number(delayMinEl.value) || 1;
  let maxSec = Number(delayMaxEl.value) || minSec;
  if (minSec > maxSec) [minSec, maxSec] = [maxSec, minSec]; // swap rather than error

  const delaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;

  for (let remaining = delaySec; remaining > 0; remaining--) {
    if (!running) break;
    while (paused || focusPaused) {
      await sleep(300);
      if (!running) break;
    }
    if (!running) break;
    setStatus(`Next prompt in ${remaining}s...`, "idle");
    await sleep(1000);
  }
}

async function runQueue() {
  running = true;
  paused = false;
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  stopBtn.disabled = false;
  updateClearButton();

  setStatus("Refreshing Flow tab...", "running");
  const refresh = await refreshFlowTab();
  if (!refresh.ok) {
    setStatus(refresh.error || "No Flow tab found — open a Flow project first.", "error");
    resetControls();
    return;
  }

  const ping = await sendToContent("PING");
  if (!ping.ok) {
    setStatus(ping.error || "No Flow tab found — open a Flow project first.", "error");
    resetControls();
    return;
  }
  if (ping.agentModeOn) {
    setStatus("Agent mode is on — turn it off in Flow to continue.", "error");
    resetControls();
    return;
  }

  for (let i = 0; i < queue.length; i++) {
    if (!running) break;
    while (paused || focusPaused) {
      await sleep(300);
      if (!running) break;
    }
    if (!running) break;

    if (queue[i].status === "done") continue; // already completed in a prior run

    currentIndex = i;
    queue[i].status = "running";
    renderQueue();
    setStatus(`Running ${i + 1} of ${queue.length}...`, "running");

    const images = await resolveQueueImages(queue[i]);
    const result = await sendToContent("RUN_PROMPT", { text: queue[i].text, images });
    queue[i].status = result.ok ? "done" : "error";
    renderQueue();

    if (!result.ok) {
      setStatus(`Prompt ${i + 1} failed: ${result.error}`, "error");
    } else if (autoDownloadEl.checked) {
      await downloadResult(result.result, i);
    }

    // No point counting down a delay after the last prompt, or if every
    // remaining item is already done (e.g. resuming a queue that only had
    // one item left).
    const hasMoreWork = queue.slice(i + 1).some((item) => item.status !== "done");
    if (running && hasMoreWork) {
      await delayWithCountdown();
    }
  }

  if (running) {
    // Ran to natural completion (as opposed to being stopped partway) —
    // clear the queue so the next "Start queue" click loads a fresh batch
    // from the textarea instead of silently re-running the same one.
    const hadErrors = queue.some((item) => item.status === "error");
    queue = [];
    renderQueue();
    if (hadErrors) {
      setStatus("Queue complete — some prompts failed. Review and try again.", "error");
    } else {
      resetToStartingState();
      setStatus("Batch complete. Ready for the next batch.", "idle");
    }
  }
  resetControls();
}

function resetControls() {
  running = false;
  paused = false;
  focusPaused = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  updateClearButton();
  pauseBtn.textContent = "Pause";
}

// Clears the prompts textarea and queue/index back to a fresh-panel state
// after a fully successful batch. Deliberately leaves Consistent Character
// (toggle, uploaded images) and Auto Download (toggle, folder) alone, along
// with the delay fields — those are per-user preferences that should carry
// over batch to batch, not per-batch inputs.
function resetToStartingState() {
  promptsEl.value = "";
  queue = [];
  currentIndex = -1;
  renderQueue();
}

/**
 * Auto-pause/resume the queue as the Flow tab gains or loses "visible,
 * active tab" status, per background.js's FLOW_FOCUS_CHANGED broadcast.
 * Separate from the user's own Pause button (`paused`) so the two don't
 * fight: if the user manually paused before switching away, regaining focus
 * clears `focusPaused` but the manual `paused` flag still holds the queue,
 * matching the wait loops' `paused || focusPaused` check.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "panel" || message.type !== "FLOW_FOCUS_CHANGED") return;
  if (!running) {
    focusPaused = false;
    return;
  }
  const wasFocusPaused = focusPaused;
  focusPaused = !message.payload.focused;
  if (focusPaused && !wasFocusPaused) {
    setStatus("Paused — Flow tab isn't focused (avoiding background-tab throttling). Switch back to resume.", "idle");
  } else if (!focusPaused && wasFocusPaused && !paused) {
    setStatus("Flow tab focused again — resuming...", "running");
  }
});

startBtn.addEventListener("click", () => {
  // If the current queue still has unfinished items (stopped partway
  // through, or a prompt errored out), resume it in place rather than
  // rebuilding from the textarea and losing track of what's already done.
  // Only load a fresh queue from the textarea once everything in the
  // current one is done (or there's no queue yet).
  const hasUnfinishedWork = queue.length > 0 && queue.some((item) => item.status !== "done");

  if (hasUnfinishedWork) {
    queue.forEach((item) => {
      if (item.status !== "done") item.status = "pending";
    });
  } else {
    const lines = promptsEl.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      setStatus("Add at least one prompt first.", "error");
      return;
    }

    queue = lines.map((text) => {
      const match = consistentCharacterToggleEl.checked
        ? CharacterMatcher.matchCharactersInText(text, characterRecords)
        : { matched: [] };
      return { text, status: "pending", matchedImages: match.matched };
    });
  }

  renderQueue();
  runQueue();
});

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  setStatus(paused ? "Paused." : "Resuming...", paused ? "idle" : "running");
});

stopBtn.addEventListener("click", () => {
  running = false;
  setStatus("Stopped.", "idle");
  resetControls();
});

clearBtn.addEventListener("click", () => {
  queue = [];
  renderQueue();
  setStatus("Queue cleared.", "idle");
});
