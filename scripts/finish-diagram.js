#!/usr/bin/env node
/**
 * Run this after editing a diagram in Excalidraw. It does the arithmetic so the author
 * does not have to.
 *
 * Two things, in this order:
 *
 *   1. Normalise the content to 684 units wide. Editing moves things, so the extent drifts;
 *      this snaps it back. Visually a no-op -- everything scales together and the build then
 *      scales the figure to the column by the reciprocal.
 *
 *   2. Report any text that is NOT on the standard ladder. It does not rescale type.
 *
 * Because the canvas is pinned at 684, Excalidraw's own toolbar presets ARE the printed
 * sizes -- S is 8pt, M is 10pt, L is 14pt, XL is 18pt, in every diagram in the book. So the
 * author picks from the toolbar like normal and gets uniformity for free. An earlier version
 * rescaled type per diagram to hit a target; that worked but left odd values like 13.1 and
 * 26.2 in the files, which is exactly the "numbers that mean nothing" problem we just removed.
 *
 * Geometry is snapped WITHOUT touching fontSize, so standard sizes stay standard. A large
 * snap would change how text sits in its boxes, so anything past 10% is a warning rather
 * than a silent fix.
 *
 *   node finish-diagram.js ch1/foo.excalidraw      one file
 *   node finish-diagram.js --all                   every file
 *   node finish-diagram.js --check ch1/foo         report only, change nothing
 */
const fs = require('fs');
const path = require('path');

const UPP = 2;                         // units per printed point
const CANVAS_W = 4.75 * 72 * UPP;      // 684
// Excalidraw's toolbar presets, which at 2 units/pt are exactly the sizes we want.
const LADDER = { 16: 'S  label 8pt', 20: 'M  heading 10pt', 28: 'L  subtitle 14pt', 36: 'XL title 18pt' };
const LABEL_UNITS = 16;
const MIN_STROKE = 0.3 * UPP;          // 0.6 == 0.3pt, comfortably above hairline

const ROOT = path.resolve(__dirname, '..', '..', 'images', 'diagrams');
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const all = argv.includes('--all');
const targets = argv.filter((a) => !a.startsWith('--'));

function listAll(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listAll(p);
    return e.name.endsWith('.excalidraw') ? [p] : [];
  });
}

function bbox(els) {
  const live = els.filter((e) => !e.isDeleted && typeof e.x === 'number');
  if (!live.length) return null;
  return {
    x0: Math.min(...live.map((e) => e.x)),
    y0: Math.min(...live.map((e) => e.y)),
    w: Math.max(...live.map((e) => e.x + (e.width || 0))) - Math.min(...live.map((e) => e.x)),
    h: Math.max(...live.map((e) => e.y + (e.height || 0))) - Math.min(...live.map((e) => e.y)),
  };
}

const SCALE = ['x', 'y', 'width', 'height', 'fontSize', 'strokeWidth', 'baseline'];

function finish(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const els = doc.elements || [];
  const b = bbox(els);
  if (!b || b.w <= 0) return null;

  const texts = els.filter((e) => e.type === 'text' && (e.text || '').trim());
  if (!texts.length) return null;

  const k = CANVAS_W / b.w;
  const offLadder = [...new Set(texts.map((t) => t.fontSize))]
    .filter((v) => !(Math.round(v) in LADDER) || Math.abs(v - Math.round(v)) > 0.01)
    .sort((a, b2) => a - b2);
  const before = { w: b.w, offLadder, drift: k };

  if (check) return { ...before, ok: Math.abs(k - 1) < 0.01 && !offLadder.length };

  // Geometry only. fontSize is deliberately NOT in this loop: the author chose those from the
  // toolbar and they are already the right printed sizes.
  for (const el of els) {
    for (const f of SCALE) {
      if (f === 'fontSize') continue;
      if (typeof el[f] === 'number') el[f] *= k;
    }
    if (Array.isArray(el.points)) el.points = el.points.map((p) => p.map((n) => n * k));
  }
  // Keep strokes off the hairline. Not scaled with the text -- line weight is its own decision.
  for (const el of els) {
    if (typeof el.strokeWidth === 'number' && el.strokeWidth < MIN_STROKE) el.strokeWidth = MIN_STROKE;
  }
  const nb = bbox(els);
  for (const el of els) { el.x -= nb.x0; el.y -= nb.y0; }

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return { ...before, applied: true };
}

const files = all ? listAll(ROOT)
  : targets.map((t) => {
      const p = t.endsWith('.excalidraw') ? t : `${t}.excalidraw`;
      return path.isAbsolute(p) ? p : path.join(ROOT, p);
    });

if (!files.length) { console.error('  give a file, or --all'); process.exit(1); }

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const r = finish(f);
  if (!r) { console.log(`  ${rel}: no text, skipped`); continue; }
  const drift = Math.abs(r.drift - 1);
  const bits = [];
  if (drift > 0.001) bits.push(`width ${r.w.toFixed(0)} -> 684${drift > 0.10 ? '  ** >10%, check text still fits its boxes **' : ''}`);
  if (r.offLadder.length) bits.push(`off-ladder type: ${r.offLadder.map((v) => v.toFixed(1)).join(', ')}`);
  const tag = check ? (r.ok ? 'OK  ' : 'TODO') : (bits.length ? '    ' : 'OK  ');
  console.log(`  ${tag} ${rel.padEnd(46)} ${bits.join('   ') || 'on the ladder, 684 wide'}`);
}
