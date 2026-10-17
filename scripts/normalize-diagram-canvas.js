#!/usr/bin/env node
/**
 * Put every diagram into one coordinate system: content exactly CANVAS_W units wide.
 *
 * WHY
 * ---
 * A figure's printed text size is  fontSize x (column width / content width).  Content width
 * is arbitrary and invisible while you draw, so identical source numbers print at wildly
 * different sizes: fontSize 18 prints 2.6pt in one figure and 7.6pt in another. Strokes have
 * the same 4.6x spread, some landing below the 0.25pt hairline a press can drop.
 *
 * Fixing content width to a known multiple of printed points removes the hidden variable.
 * At 2 units per point and a 4.75in column, CANVAS_W is 684 and:
 *
 *     fontSize 16 -> 8pt    (Excalidraw's "S" preset, i.e. the toolbar default is correct)
 *     fontSize 20 -> 10pt   ("M")      28 -> 14pt ("L")      36 -> 18pt ("XL")
 *     strokeWidth 1 -> 0.5pt
 *
 * THIS SCRIPT CHANGES NOTHING ABOUT HOW THE BOOK LOOKS.
 * Every geometric quantity scales by the same k, and the build then scales the figure to the
 * column by 1/k of what it did before. The two cancel exactly. What it changes is that the
 * numbers in the file finally MEAN something: after this, source fontSize is just twice the
 * printed point size, so a 3pt label reads as 6 next to a toolbar whose smallest preset is 16.
 * The defect becomes visible in the editor instead of at proof.
 *
 * Deliberately NOT scaled: angle, roughness, opacity, seed, lineHeight (a ratio), and the
 * version/nonce bookkeeping.
 */
const fs = require('fs');
const path = require('path');

const UNITS_PER_POINT = 2;
const COLUMN_IN = 4.75;
const CANVAS_W = COLUMN_IN * 72 * UNITS_PER_POINT;   // 684

const ROOT = path.resolve(__dirname, '..', '..', 'images', 'diagrams');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const SCALE_FIELDS = ['x', 'y', 'width', 'height', 'fontSize', 'strokeWidth', 'baseline'];

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.excalidraw') ? [p] : [];
  });
}

function bbox(els) {
  const live = els.filter((e) => !e.isDeleted && typeof e.x === 'number');
  if (!live.length) return null;
  const x0 = Math.min(...live.map((e) => e.x));
  const y0 = Math.min(...live.map((e) => e.y));
  const x1 = Math.max(...live.map((e) => e.x + (e.width || 0)));
  const y1 = Math.max(...live.map((e) => e.y + (e.height || 0)));
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/** Printed size of a given source fontSize, under the build's width=\maxwidth placement. */
function printedPt(fontSize, b) {
  const wIn = Math.min(COLUMN_IN, 7.5 * b.w / b.h);
  return fontSize * wIn * 72 / b.w;
}

let changed = 0, drift = 0;
for (const file of sources(ROOT)) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const els = doc.elements || [];
  const b = bbox(els);
  if (!b || b.w <= 0 || b.h <= 0) continue;

  const k = CANVAS_W / b.w;
  if (Math.abs(k - 1) < 1e-9) continue;

  // Record what a representative label prints at, to prove the transform is a no-op.
  const sample = els.find((e) => e.type === 'text' && e.text && e.text.trim());
  const before = sample ? printedPt(sample.fontSize || 20, b) : null;

  for (const el of els) {
    for (const f of SCALE_FIELDS) {
      if (typeof el[f] === 'number') el[f] = el[f] * k;
    }
    // Arrows and lines carry their geometry as offsets from (x, y).
    if (Array.isArray(el.points)) {
      el.points = el.points.map((p) => (Array.isArray(p) ? p.map((n) => n * k) : p));
    }
  }
  // Re-origin so every file starts at (0, 0): the canvas becomes comparable between files.
  const nb = bbox(els);
  for (const el of els) {
    if (typeof el.x === 'number') el.x -= nb.x0;
    if (typeof el.y === 'number') el.y -= nb.y0;
  }

  const after = sample ? printedPt(sample.fontSize, bbox(els)) : null;
  if (before !== null && Math.abs(before - after) > 0.01) {
    console.error(`  !! ${path.relative(ROOT, file)}: ${before.toFixed(2)}pt -> ${after.toFixed(2)}pt`);
    drift++;
  }

  if (!dryRun) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  changed++;
  console.log(`  ${k.toFixed(3)}x  ${path.relative(ROOT, file).padEnd(48)} `
            + `${b.w.toFixed(0)} -> ${CANVAS_W} wide`);
}

console.log();
console.log(`  ${changed} file(s) ${dryRun ? 'would be' : ''} normalised to ${CANVAS_W} units wide`);
console.log(`  printed-size drift: ${drift} file(s)  ${drift ? '** NOT a no-op **' : '(none -- transform is exact)'}`);
