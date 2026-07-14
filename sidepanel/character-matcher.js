// Overflow — character name matching (Consistent Character feature)
//
// Pure logic, no chrome.* APIs, no DOM, no storage — takes prompt text plus
// the list of uploaded character records and decides which reference
// images should be attached before a prompt is submitted to Flow.
//
// Loaded as a plain <script> tag (no build step in this repo), exposing a
// single global: window.CharacterMatcher.
//
// This is a heuristic, not a parser. Two things it deliberately handles:
//   1. A character name mentioned by an uploaded file's basename should
//      match case-insensitively, as a whole word, anywhere in the prompt.
//   2. A prompt can explicitly say a character is ABSENT, e.g. "No
//      NARRATOR in frame." — a plain substring match would wrongly attach
//      the narrator image there. Negation cues immediately before a name
//      (within the same sentence) suppress that specific mention.
// Unusual phrasing ("NARRATOR not in shot", a name that IS a negation cue)
// isn't handled — this may need the cue list or window size tuned once
// real prompts are seen.
//
// Deliberately does NOT guess at "referenced but not uploaded" characters
// (e.g. via an ALL-CAPS heuristic) — scene-only prompts routinely contain
// capitalized camera/shot directions ("WIDE SHOT", "CU", "INT") that aren't
// character names at all, and flagging those as errors punished prompts
// that never needed a character in the first place.

const NEGATION_CUES = new Set(["no", "not", "without", "excluding", "minus"]);
const NEGATION_WINDOW = 3; // how many preceding words to check for a cue

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if the closest sentence-scoped words before `matchIndex` contain a
 * negation cue. Sentence boundary is the nearest preceding '.', '!', or
 * '?' (or the start of the text) — a negation in a prior sentence doesn't
 * leak forward onto this occurrence.
 */
function isNegatedOccurrence(text, matchIndex) {
  let sentenceStart = 0;
  for (let i = matchIndex - 1; i >= 0; i--) {
    if (text[i] === "." || text[i] === "!" || text[i] === "?") {
      sentenceStart = i + 1;
      break;
    }
  }
  const preceding = text.slice(sentenceStart, matchIndex);
  const words = preceding
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-zA-Z]/g, "").toLowerCase());
  const window = words.slice(-NEGATION_WINDOW);
  return window.some((w) => NEGATION_CUES.has(w));
}

/**
 * Find every whole-word, case-insensitive occurrence of `name` in `text`,
 * returning each occurrence's negation status.
 */
function findOccurrences(text, name) {
  const escaped = escapeRegExp(name);
  if (!escaped) return [];
  const regex = new RegExp(`\\b${escaped}\\b`, "gi");
  const occurrences = [];
  let match;
  while ((match = regex.exec(text))) {
    occurrences.push({ index: match.index, negated: isNegatedOccurrence(text, match.index) });
    if (match.index === regex.lastIndex) regex.lastIndex++; // guard against zero-width matches
  }
  return occurrences;
}

/**
 * @param {string} text - a single queued prompt's text
 * @param {{id: string, characterName: string}[]} characterRecords - uploaded character images
 * @returns {{matched: {id: string, characterName: string}[]}}
 */
function matchCharactersInText(text, characterRecords) {
  const matched = [];

  for (const record of characterRecords) {
    const occurrences = findOccurrences(text, record.characterName);
    if (occurrences.length === 0) continue;
    const hasPositive = occurrences.some((o) => !o.negated);
    if (hasPositive) {
      matched.push({ id: record.id, characterName: record.characterName });
    }
    // If every occurrence is negated ("No NARRATOR..."), the character is
    // deliberately excluded.
  }

  return { matched };
}

window.CharacterMatcher = { matchCharactersInText };
