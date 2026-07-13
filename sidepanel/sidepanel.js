// Overflow — side panel logic
//
// Owns the queue state and drives it forward one prompt at a time,
// sending each prompt to the content script via background.js and
// waiting for the result before moving on.

const promptsEl = document.getElementById("prompts");
const promptFileEl = document.getElementById("prompt-file");
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

let queue = [];       // [{ text, status }]
let currentIndex = -1;
let running = false;
let paused = false;

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
    const badge = document.createElement("span");
    badge.className = `status-badge ${item.status}`;
    badge.textContent = STATUS_LABELS[item.status] || item.status;
    li.appendChild(dot);
    li.appendChild(text);
    li.appendChild(badge);
    queueListEl.appendChild(li);
  });
  const done = queue.filter((q) => q.status === "done").length;
  queueProgressEl.textContent = `${done} / ${queue.length}`;
}

/**
 * Turn prompt text into a filename-safe slug: lowercase, non-alphanumeric
 * runs collapsed to single hyphens, truncated to ~40 chars at a word
 * boundary (extending slightly past 40 rather than cutting mid-word).
 */
function slugify(text, maxLength = 40) {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > maxLength) {
    let cut = slug.indexOf("-", maxLength);
    if (cut === -1) cut = slug.length;
    slug = slug.slice(0, cut);
  }

  return slug.replace(/-+$/, "");
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
    const lines = String(reader.result)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    promptsEl.value = lines.join("\n");
  };
  reader.readAsText(file);
  promptFileEl.value = ""; // allow re-selecting the same file later
});

/**
 * Download a completed result, named "{index}-{slug}.{ext}" inside the
 * optional user-supplied subfolder. No-ops if there's no result URL.
 *
 * The URL from flow.js is a normal same-origin URL (not a page-scoped
 * blob: URL), so chrome.downloads.download() can fetch it directly using
 * the browser's own cookies — no need to pass image bytes through
 * chrome.runtime messaging.
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

    const ext = resultData.mediaType === "video" ? "mp4" : "png";
    const slug = slugify(queue[index].text);
    const baseName = `${index + 1}-${slug}.${ext}`;
    const folder = sanitizeFolderName(downloadFolderEl.value);
    const filename = folder ? `${folder}/${baseName}` : baseName;

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

    chrome.downloads.download({ url: resultData.url, filename, saveAs: false }, () => {
      clearTimeout(timeout);
      settle();
    });
  });
}

autoDownloadEl.addEventListener("change", () => {
  downloadSettingsHintEl.hidden = !autoDownloadEl.checked;
});

openDownloadSettingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
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

/**
 * Poll for a live Flow tab so the status bar reflects reality instead of
 * showing its static "Idle" placeholder forever. Skipped while a queue is
 * running so it doesn't clobber the in-progress status text.
 */
async function checkFlowTab() {
  if (running) return;
  const ping = await sendToContent("PING");
  setStatus(
    ping.ok ? "Flow tab detected — ready to start." : ping.error || "No Flow tab found — open a Flow project tab.",
    ping.ok ? "idle" : "error"
  );
}

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
    while (paused) {
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
  clearBtn.disabled = true;

  const ping = await sendToContent("PING");
  if (!ping.ok) {
    setStatus(ping.error || "No Flow tab found — open a Flow project first.", "error");
    resetControls();
    return;
  }

  for (let i = 0; i < queue.length; i++) {
    if (!running) break;
    while (paused) {
      await sleep(300);
      if (!running) break;
    }
    if (!running) break;

    if (queue[i].status === "done") continue; // already completed in a prior run

    currentIndex = i;
    queue[i].status = "running";
    renderQueue();
    setStatus(`Running ${i + 1} of ${queue.length}...`, "running");

    const result = await sendToContent("RUN_PROMPT", { text: queue[i].text });
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
    queue = [];
    renderQueue();
    setStatus("Queue complete. Add new prompts to start again.", "idle");
  }
  resetControls();
}

function resetControls() {
  running = false;
  paused = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  clearBtn.disabled = false;
  pauseBtn.textContent = "Pause";
}

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

    queue = lines.map((text) => ({ text, status: "pending" }));
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
