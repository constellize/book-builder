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
 *   2. Scale all text so the diagram's MOST COMMON label lands on 16 units = 8pt printed.
 *      Relative hierarchy is untouched: if a title was twice the body label, it still is.
 *
 * So the author never picks a font size to hit a printed target. Draw it so it reads, run
 * this, and the printed size is right -- and identical to every other figure in the book.
 *
 *   node finish-diagram.js ch1/foo.excalidraw      one file
 *   node finish-diagram.js --all                   every file
 *   node finish-diagram.js --check ch1/foo         report only, change nothing
 */
const fs = require('fs');
const path = require('path');

const UPP = 2;                         // units per printed point
const CANVAS_W = 4.75 * 72 * UPP;      // 684
const LABEL_UNITS = 8 * UPP;           // 16  == Excalidraw's "S" preset == 8pt printed
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

  // 1. geometry -> 684 wide
  const k = CANVAS_W / b.w;
  // 2. type: the modal size becomes LABEL_UNITS, measured AFTER the geometry scale
  const counts = new Map();
  for (const t of texts) counts.set(t.fontSize, (counts.get(t.fontSize) || 0) + 1);
  const modal = [...counts.entries()].sort((a, b2) => b2[1] - a[1] || b2[0] - a[0])[0][0];
  const kText = LABEL_UNITS / (modal * k);

  const before = { w: b.w, modal, modalPt: modal * (Math.min(4.75, 7.5 * b.w / b.h) * 72 / b.w) };

  if (check) {
    return { ...before, needGeom: k, needText: kText,
             ok: Math.abs(k - 1) < 0.01 && Math.abs(kText - 1) < 0.01 };
  }

  for (const el of els) {
    for (const f of SCALE) if (typeof el[f] === 'number') el[f] *= k;
    if (Array.isArray(el.points)) el.points = el.points.map((p) => p.map((n) => n * k));
  }
  for (const t of texts) t.fontSize *= kText;
  // Keep strokes off the hairline. Not scaled with the text -- line weight is its own decision.
  for (const el of els) {
    if (typeof el.strokeWidth === 'number' && el.strokeWidth < MIN_STROKE) el.strokeWidth = MIN_STROKE;
  }
  const nb = bbox(els);
  for (const el of els) { el.x -= nb.x0; el.y -= nb.y0; }

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return { ...before, geom: k, text: kText, after: LABEL_UNITS / UPP };
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
  if (check) {
    console.log(`  ${r.ok ? 'OK  ' : 'TODO'} ${rel.padEnd(46)} `
      + `label ${r.modalPt.toFixed(1)}pt  (geometry ${r.needGeom.toFixed(2)}x, type ${r.needText.toFixed(2)}x)`);
  } else {
    console.log(`  ${rel.padEnd(46)} label ${r.modalPt.toFixed(1)}pt -> ${r.after}pt`);
  }
}
