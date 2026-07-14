#!/usr/bin/env node
// Bumps manifest.json's version. Chrome's MV3 "version" field must be 1-4
// dot-separated integers (no "-alpha"/"-beta" suffixes allowed), so this repo
// uses the 4th segment as a build/pre-release counter instead:
//   major.minor.patch.build
// Bumping a segment resets every segment to its right to 0.
//
// Usage: node scripts/bump-version.js <major|minor|patch|build>
//
// Edits the version string in place via regex rather than
// JSON.parse/stringify, so the rest of manifest.json's formatting
// (array layout, key order, etc.) is left untouched.

const fs = require("fs");
const path = require("path");

const SEGMENTS = ["major", "minor", "patch", "build"];
const manifestPath = path.join(__dirname, "..", "manifest.json");

const segment = process.argv[2];
const segmentIndex = SEGMENTS.indexOf(segment);
if (segmentIndex === -1) {
  console.error(`Usage: node scripts/bump-version.js <${SEGMENTS.join("|")}>`);
  process.exit(1);
}

const raw = fs.readFileSync(manifestPath, "utf8");
const versionLine = raw.match(/"version"\s*:\s*"([0-9]+(?:\.[0-9]+){0,3})"/);
if (!versionLine) {
  console.error('Could not find a "version": "..." field in manifest.json');
  process.exit(1);
}

const parts = versionLine[1].split(".").map(Number);
while (parts.length < 4) parts.push(0);

parts[segmentIndex] += 1;
for (let i = segmentIndex + 1; i < parts.length; i++) parts[i] = 0;

const nextVersion = parts.join(".");
const updated = raw.replace(versionLine[0], `"version": "${nextVersion}"`);
fs.writeFileSync(manifestPath, updated);

console.log(`Bumped ${segment} -> version ${nextVersion}`);
