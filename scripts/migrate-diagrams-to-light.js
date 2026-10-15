#!/usr/bin/env node
/**
 * Rewrite the .excalidraw SOURCES to the light palette.
 *
 * WHY THIS EXISTS
 * ---------------
 * The light theme used to be applied at render time only: the sources stayed dark and
 * diagram-theme.js remapped on the way out. That works for the build and is wrong for the
 * author -- you open a diagram to fix its padding and you are looking at navy on near-black,
 * while the book prints white. You cannot judge spacing, weight or contrast in colours the
 * reader never sees.
 *
 * After this runs, the editor shows what prints and the render-time remap becomes a no-op
 * (it stays in place, harmless, because re-running it on light sources changes nothing).
 *
 * Run with --dry-run first. --check exits non-zero if anything is still dark, for CI.
 */
const fs = require('fs');
const path = require('path');
const { toLightTheme, remapColor } = require('./lib/diagram-theme.js');

const ROOT = path.resolve(__dirname, '..', '..', 'images', 'diagrams');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const check = args.includes('--check');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.excalidraw') ? [p] : [];
  });
}

/** Colours still unmapped after the pass -- these would stay dark, so they must be named. */
function stragglers(doc) {
  const out = new Map();
  const note = (v) => {
    if (typeof v !== 'string' || !v.startsWith('#')) return;
    if (remapColor(v) === v) out.set(v, (out.get(v) || 0) + 1);
  };
  note(doc.appState && doc.appState.viewBackgroundColor);
  for (const el of doc.elements || []) { note(el.strokeColor); note(el.backgroundColor); }
  return out;
}

const files = sources(ROOT);
let touched = 0, totalEdits = 0;
const unmapped = new Map();

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);

  for (const [c, n] of stragglers(doc)) unmapped.set(c, (unmapped.get(c) || 0) + n);

  const edits = toLightTheme(doc);
  if (!edits) continue;
  touched++; totalEdits += edits;

  // Match Excalidraw's own formatting: 2-space indent, trailing newline. Keeping the shape
  // the app writes means a later save in the app produces a small diff, not a whole-file one.
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`  ${edits.toString().padStart(4)} edit(s)  ${path.relative(ROOT, file)}`);
}

console.log();
console.log(`  ${touched} of ${files.length} file(s) ${dryRun ? 'would change' : 'changed'}, ${totalEdits} colour edits`);

if (unmapped.size) {
  console.log();
  console.log('  NOT remapped -- these keep their current colour:');
  for (const [c, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(12)} ${n}`);
  }
  if (check) { console.error('\n  --check: unmapped colours present'); process.exit(1); }
}
