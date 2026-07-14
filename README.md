# Overflow

Free, bulk prompt automation for Google Flow. Paste a list of prompts, walk
away, come back to generated (and optionally downloaded) results — no paid
tier gatekeeping basic queueing.

## Status: alpha (`1.0.0.0`)

This is the first public alpha. The core flow — queue prompts, generate in
bulk, auto-download results — works end to end and has been used for real
batches, but it hasn't been through wide testing yet. Expect rough edges.

## Features

- **Bulk prompt queue** — paste or upload a list of prompts (blank lines
  between paragraphs are preserved), set a min/max delay, then Start. The
  queue runs unattended: types each prompt with human-like pacing, submits
  via a genuinely trusted click (Flow ignores synthetic clicks on its
  Generate button), and waits for the result before moving on.
- **Pause / Resume / Clear queue** — pause and resume manually at any point;
  a queue that finishes cleanly resets the panel for the next batch, while a
  batch with errors leaves the prompts in place so you can review and retry.
- **Auto-pause on focus loss** — automatically pauses if the Flow tab isn't
  the active tab (Chrome throttles background-tab timers, which can silently
  stall a long run), and resumes the moment it's focused again.
- **Consistent Character** — upload reference images named after your
  characters (e.g. `narrator.png`); each queued prompt is scanned for name
  matches (negation-aware — "no NARRATOR in frame" won't attach it) and the
  matching images are attached to the composer before the prompt runs, so
  the same character stays visually consistent across a batch.
- **Auto Download** — automatically saves each finished result into a chosen
  subfolder with zero-padded filenames (`001.jpg`, `002.jpg`, ...) instead of
  Flow's own asset UUIDs.
- **Guardrails** — a blocking overlay when you're not on a Flow project tab
  (with a one-click link to open one), and another if Flow's Agent/chat mode
  is on, since this automation targets the standard prompt composer.
- **About tab** — version, author, and website, read live from
  `manifest.json` so it can't drift out of sync.

## Installing (unpacked)

Overflow isn't on the Chrome Web Store yet — load it as an unpacked
extension:

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. "Load unpacked" → select this folder
4. Click the Overflow icon in the toolbar → the side panel opens on a Flow
   project tab (`labs.google/fx/...`)

## Versioning

`manifest.json`'s `version` field is constrained by Chrome to plain
`major.minor.patch.build` integers — no `-alpha`/`-beta` suffixes are
permitted, even for unpacked/dev use. This repo uses the 4th segment as a
pre-release build counter instead of a text suffix, e.g. `1.0.0.0` is the
first alpha build of the `1.0.0` line. The alpha/beta/stable status itself is
tracked in this README and [Changelog.md](https://github.com/s4ndm4ndev/Overflow/blob/master/CHANGELOG.md), not in the manifest.

To bump the version:

```
node scripts/bump-version.js <major|minor|patch|build>
```

Bumping a segment resets everything to its right to `0` (standard semver
behavior) — e.g. `patch` on `1.2.3.4` gives `1.2.4.0`.

## Known limitations

- Not published to the Chrome Web Store — install as unpacked for now.
- Only supports Flow's standard prompt composer, not Agent/chat mode.
- Prompt queue lives in the side panel's memory only — closing the panel
  loses progress on the current batch.
- No rate-limit/detection-risk tuning beyond the configurable delay and
  human-like typing pace.
