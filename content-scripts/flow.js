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

		// The main-world script types word-by-word with a per-word pause (see
		// flow-main-world.js), so the ceiling has to scale with prompt length
		// rather than being a fixed guess — a fixed 30s was tight enough that a
		// longer prompt (or a throttled background tab, where Chrome slows down
		// setTimeout) could still legitimately blow past it. Budget generously
		// per word (well above the ~380ms max per-word delay) plus a flat
		// buffer for throttling/overhead, floored at 30s for short prompts.
		const wordCount = text.split(" ").length;
		const timeoutMs = Math.max(30000, wordCount * 500 + 10000);
		const timeout = setTimeout(() => {
			window.removeEventListener("message", onMessage);
			reject(
				new Error(
					"Timed out waiting for the prompt composer to update.",
				),
			);
		}, timeoutMs);

		function onMessage(event) {
			if (event.source !== window) return;
			const message = event.data;
			if (
				!message ||
				message.source !== "overflow-main-world" ||
				message.requestId !== requestId
			)
				return;
			clearTimeout(timeout);
			window.removeEventListener("message", onMessage);
			if (message.ok) resolve();
			else
				reject(
					new Error(
						message.error || "Failed to set the prompt text.",
					),
				);
		}
		window.addEventListener("message", onMessage);

		window.postMessage(
			{
				source: "overflow-isolated",
				type: "SET_PROMPT_TEXT",
				requestId,
				text,
			},
			"*",
		);
	});
}

// --- Consistent Character feature: attaching reference images to Flow's
// composer before a prompt's text is set. Confirmed via live inspection
// (see Changelog.md) that this needs a mix of plain synthetic events and
// one genuinely trusted click, differently from both the text composer
// (Slate/React fiber, main-world only) and the Generate button (trusted
// click for everything).

function findButtonsByIcon(ligature) {
	return Array.from(document.querySelectorAll("button")).filter((b) => {
		const icon = b.querySelector("i");
		return icon && icon.textContent.trim() === ligature;
	});
}

function findButtonByIcon(ligature) {
	return findButtonsByIcon(ligature)[0] || null;
}

/**
 * The composer's "+" attach-media button — the exact button
 * findGenerateButton() above has to filter OUT (both share the same
 * hidden "Create" accessible name), identified here by its own icon-font
 * ligature instead. Confirmed via live inspection: opening it is a plain
 * synthetic-click-friendly action, unlike Generate.
 */
function findAttachButton() {
	return findButtonByIcon("add_2");
}

/** Number of reference images currently attached to the composer — each
 * has a remove control with icon ligature "cancel". Used to confirm an
 * attach actually landed, by comparing the count before/after. */
function countAttachedChips() {
	return findButtonsByIcon("cancel").length;
}

function getAncestors(el) {
	const ancestors = [];
	let cur = el;
	while (cur) {
		ancestors.push(cur);
		cur = cur.parentElement;
	}
	return ancestors;
}

function commonAncestor(a, b) {
	const ancestorsB = new Set(getAncestors(b));
	for (const el of getAncestors(a)) {
		if (ancestorsB.has(el)) return el;
	}
	return document.body;
}

/**
 * The attach-image picker popup, located as the nearest common ancestor of
 * its "Search assets" input and "Upload media" button — both stable,
 * text-identified anchors, same philosophy as this file's icon-ligature
 * lookups. Necessary because confirmed live: the project's background
 * media grid renders tiles with the SAME filename text at the same time
 * the picker is open, so an unscoped document-wide search for a filename
 * can match the wrong (background) tile instead of the picker's own.
 */
function findAssetPickerContainer() {
	const searchInput = Array.from(document.querySelectorAll("input")).find(
		(i) => (i.placeholder || "").trim() === "Search assets",
	);
	const uploadMediaBtn = Array.from(document.querySelectorAll("button")).find(
		(b) => (b.textContent || "").includes("Upload media"),
	);
	if (!searchInput || !uploadMediaBtn) return null;
	return commonAncestor(searchInput, uploadMediaBtn);
}

/**
 * Within `root`, find the asset tile for `fileName`. Flow echoes an
 * uploaded file's name back verbatim in its asset list (confirmed live),
 * so an exact text match on a leaf element reliably identifies it; climb
 * to the smallest ancestor at least ~60x60px to land on the actual
 * clickable row rather than the bare text label.
 */
function findAssetTileByFileName(fileName, root) {
	if (!root) return null;
	const leaf = Array.from(root.querySelectorAll("*")).find(
		(el) => el.children.length === 0 && el.textContent.trim() === fileName,
	);
	if (!leaf) return null;
	let el = leaf;
	for (let i = 0; i < 8 && el; i++) {
		const rect = el.getBoundingClientRect();
		if (rect.width >= 60 && rect.height >= 60) return el;
		el = el.parentElement;
	}
	return leaf;
}

function findAddToPromptButton() {
	return Array.from(document.querySelectorAll("button")).find(
		(b) => b.textContent.trim() === "Add to Prompt",
	);
}

/**
 * Poll `check` until it returns a truthy value or `timeoutMs` elapses.
 * Same shape as waitForGenerateButtonReady() below, generalized — used
 * throughout attachCharacterImage() because every step here (upload
 * landing in the asset list, the picker opening, the tile appearing)
 * confirmed live to lag its trigger by a variable amount, not a fixed one.
 */
function waitFor(check, timeoutMs, intervalMs = 150) {
	return new Promise((resolve) => {
		const start = Date.now();
		const poll = () => {
			const result = check();
			if (result) {
				resolve(result);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				resolve(null);
				return;
			}
			setTimeout(poll, intervalMs);
		};
		poll();
	});
}

function isButtonDisabled(btn) {
	return btn.disabled || btn.getAttribute("aria-disabled") === "true";
}

/**
 * Poll until a freshly-located Generate button reports enabled, and resolve
 * with that fresh reference — never a cached one.
 *
 * Confirmed live: the composer visibly grows into a tall multi-line block as
 * a long prompt lands, which is enough layout change for React to swap out
 * the button's DOM node entirely. A single button reference captured once
 * and reused later can go stale — and a detached node's
 * getBoundingClientRect() silently returns an all-zero rect rather than
 * throwing, which would aim a click at (0,0) instead of erroring. Symptom
 * matched exactly: chrome.debugger reported success (banner shown, no
 * console error) but the composer sat untouched afterward. Re-finding the
 * button on every poll (and again immediately before the actual click, in
 * clickGenerateButton()) avoids ever acting on a stale reference.
 */
function waitForGenerateButtonReady(timeoutMs = 2000) {
	return new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			const btn = findGenerateButton();
			if (btn && !isButtonDisabled(btn)) {
				resolve(btn);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				resolve(null);
				return;
			}
			setTimeout(check, 50);
		};
		check();
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
			.map((el) => el.getAttribute("data-tile-id")),
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
			const newlyFinished = Array.from(
				document.querySelectorAll("[data-tile-id]"),
			).find(
				(el) =>
					!alreadyFinished.has(el.getAttribute("data-tile-id")) &&
					tileHasFinished(el),
			);
			if (newlyFinished) {
				clearTimeout(timeout);
				observer.disconnect();
				resolve(extractResult(newlyFinished));
			}
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
		});
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
	if (!media)
		return { url: null, tileId: tileEl.getAttribute("data-tile-id") };
	return {
		url: media.currentSrc || media.src,
		mediaType: media.tagName.toLowerCase(), // "img" or "video"
		tileId: tileEl.getAttribute("data-tile-id"),
	};
}

function sendToBackground(type, payload) {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(
			{ target: "background", type, payload },
			resolve,
		);
	});
}

/**
 * Dispatch a genuinely trusted click at whatever `locate()` finds, via
 * chrome.debugger. `locate` is called fresh AFTER attaching — not given a
 * static element up front — because chrome.debugger.attach() triggers
 * Chrome's "is debugging this browser" infobar, which reflows the whole
 * page down by its own height (confirmed live by comparing screenshots
 * before/after it appears). Coordinates measured before attach point at
 * the wrong place once that reflow has happened; re-locating here avoids
 * ever acting on a pre-reflow (or otherwise stale) position. Shared by
 * clickGenerateButton() and attachCharacterImage()'s tile-selection step —
 * both confirmed live to need a real trusted click, unlike every other
 * synthetic click in this file.
 */
async function clickViaDebugger(locate, notFoundMessage) {
	const attachResponse = await sendToBackground("DEBUGGER_ATTACH");
	if (!attachResponse || !attachResponse.ok) {
		throw new Error(
			(attachResponse && attachResponse.error) ||
				"Failed to attach debugger.",
		);
	}

	try {
		// Let the infobar's reflow fully settle before measuring anything.
		await sleep(150);

		const el = locate();
		if (!el) throw new Error(notFoundMessage);
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			throw new Error(
				"Target element has no visible size — likely detached from the page.",
			);
		}
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;

		const clickResponse = await sendToBackground("DEBUGGER_CLICK", {
			x,
			y,
		});
		if (!clickResponse || !clickResponse.ok) {
			throw new Error(
				(clickResponse && clickResponse.error) || "Failed to click.",
			);
		}
	} finally {
		await sendToBackground("DEBUGGER_DETACH");
	}
}

async function clickGenerateButton() {
	await clickViaDebugger(
		findGenerateButton,
		"Could not find the Generate button.",
	);
}

/**
 * Upload a character reference image to Flow and attach it to the
 * composer, ahead of the prompt text itself (see runPrompt()). Confirmed
 * live: uploading through the hidden file input, opening the "+" picker,
 * and clicking "Add to Prompt" all accept plain synthetic events — only
 * selecting the specific tile needs a trusted click (see clickViaDebugger
 * above), the same requirement as Generate's button.
 */
async function attachCharacterImage({
	characterName,
	mimeType,
	dataUrl,
	fileName,
}) {
	const blob = await fetch(dataUrl).then((r) => r.blob());
	const file = new File([blob], fileName, { type: mimeType });

	const input = document.querySelector('input[type="file"][accept*="image"]');
	if (!input)
		throw new Error(
			`Could not find Flow's image upload input to attach ${characterName}.`,
		);

	const chipsBefore = countAttachedChips();

	const dt = new DataTransfer();
	dt.items.add(file);
	input.files = dt.files;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));

	const uploaded = await waitFor(
		() => findAssetTileByFileName(fileName, document),
		20000,
		300,
	);
	if (!uploaded)
		throw new Error(
			`Uploaded image for ${characterName} never appeared in Flow's asset list.`,
		);

	const attachBtn = findAttachButton();
	if (!attachBtn)
		throw new Error("Could not find Flow's attach-image (+) button.");
	attachBtn.click();

	const tileReady = await waitFor(
		() => findAssetTileByFileName(fileName, findAssetPickerContainer()),
		5000,
		200,
	);
	if (!tileReady)
		throw new Error(`Could not find ${fileName} in Flow's attach picker.`);

	await clickViaDebugger(
		() => findAssetTileByFileName(fileName, findAssetPickerContainer()),
		`Could not find ${fileName} in Flow's attach picker.`,
	);

	const addToPromptBtn = await waitFor(findAddToPromptButton, 3000, 150);
	if (!addToPromptBtn)
		throw new Error('Could not find the "Add to Prompt" button.');
	addToPromptBtn.click();

	const attached = await waitFor(
		() => countAttachedChips() > chipsBefore,
		5000,
		150,
	);
	if (!attached)
		throw new Error(
			`Failed to confirm ${characterName}'s image attached to the composer.`,
		);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single prompt end-to-end: attach any character reference images,
 * fill in the text, click generate, wait for result. Images are attached
 * BEFORE the text is set, matching the reference workflow this feature was
 * modeled on (attach reference, then describe the scene).
 */
async function runPrompt(text, images = []) {
	const input = findPromptInput();
	if (!input) throw new Error("Could not find the prompt input on the page.");

	for (const image of images) {
		await attachCharacterImage(image);
	}

	await setPromptText(text);

	const ready = await waitForGenerateButtonReady();
	if (!ready)
		throw new Error(
			"Generate button never became available after entering the prompt.",
		);

	// The text lands and the button enables in a single tick — instant,
	// machine-speed, back-to-back with filling the composer. Add a short
	// randomized pause here, as if someone typed the prompt and glanced over
	// it before hitting generate, rather than clicking the literal instant
	// the field allows it.
	await sleep(600 + Math.random() * 1200);
	await clickGenerateButton();

	return waitForResult();
}

/**
 * Whether Flow's "Agent" composer mode is toggled on. Confirmed via live
 * inspection: the toggle is a real <button aria-pressed="true|false"> with
 * visible text "Agent" — an accessibility attribute, not a generated class,
 * so it's stable across builds. Agent mode changes how the composer behaves
 * (it's a different, chat-style interaction), which the rest of this file's
 * automation was never built against — the panel should refuse to run while
 * it's on rather than silently misbehaving against it.
 */
function isAgentModeOn() {
	const btn = Array.from(document.querySelectorAll("button")).find(
		(b) => (b.textContent || "").trim() === "Agent",
	);
	return !!btn && btn.getAttribute("aria-pressed") === "true";
}

// Listen for commands from the side panel (relayed via background.js).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.target !== "content") return;

	if (message.type === "PING") {
		// composerReady lets background.js's post-reload wait confirm Flow's
		// React app has actually mounted the prompt input, rather than guessing
		// with a fixed delay after the page's load event (which fires well
		// before a heavy SPA finishes rendering).
		sendResponse({
			ok: true,
			agentModeOn: isAgentModeOn(),
			composerReady: !!findPromptInput(),
		});
		return;
	}

	if (message.type === "RUN_PROMPT") {
		runPrompt(message.payload.text, message.payload.images)
			.then((result) => sendResponse({ ok: true, result }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true; // async response
	}
});
