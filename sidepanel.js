// Overflow — side panel logic
//
// Owns the queue state and drives it forward one prompt at a time,
// sending each prompt to the content script via background.js and
// waiting for the result before moving on.

const promptsEl = document.getElementById("prompts");
const delayEl = document.getElementById("delay");
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

function renderQueue() {
  queueListEl.innerHTML = "";
  queue.forEach((item) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `status-dot ${item.status}`;
    const text = document.createElement("span");
    text.className = "item-text";
    text.textContent = item.text;
    li.appendChild(dot);
    li.appendChild(text);
    queueListEl.appendChild(li);
  });
  const done = queue.filter((q) => q.status === "done").length;
  queueProgressEl.textContent = `${done} / ${queue.length}`;
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
    }

    const delaySec = Number(delayEl.value) || 15;
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
