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
const downloadFolderEl = document.getElementById("download-folder");
const startBtn = document.getElementById("start");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
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

const CONTENT_TYPE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function extensionFromContentType(contentType) {
  return CONTENT_TYPE_EXTENSIONS[contentType] || null;
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
 * optional user-supplied subfolder. No-ops if there's no data URL yet
 * (waitForResult() in flow.js is still a stub).
 */
function downloadResult(resultData, index) {
  return new Promise((resolve) => {
    if (!resultData || !resultData.dataUrl) {
      resolve();
      return;
    }

    const ext = extensionFromContentType(resultData.contentType) || "png"; // TODO: derive real extension
    const slug = slugify(queue[index].text);
    const baseName = `${index + 1}-${slug}.${ext}`;
    const folder = sanitizeFolderName(downloadFolderEl.value);
    const filename = folder ? `${folder}/${baseName}` : baseName;

    chrome.downloads.download({ url: resultData.dataUrl, filename }, () => resolve());
  });
}

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

async function runQueue() {
  running = true;
  paused = false;
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  stopBtn.disabled = false;

  const ping = await sendToContent("PING");
  if (!ping.ok) {
    setStatus("No Flow tab found — open a Flow project first.", "error");
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

    let minSec = Number(delayMinEl.value) || 1;
    let maxSec = Number(delayMaxEl.value) || minSec;
    if (minSec > maxSec) [minSec, maxSec] = [maxSec, minSec]; // swap rather than error

    const delaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    await sleep(delaySec * 1000);
  }

  if (running) {
    setStatus("Queue complete.", "idle");
  }
  resetControls();
}

function resetControls() {
  running = false;
  paused = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  pauseBtn.textContent = "Pause";
}

startBtn.addEventListener("click", () => {
  const lines = promptsEl.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    setStatus("Add at least one prompt first.", "error");
    return;
  }

  queue = lines.map((text) => ({ text, status: "pending" }));
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
