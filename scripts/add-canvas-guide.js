#!/usr/bin/env node
/**
 * Pin every diagram's bounding box at 684 units with an invisible guide rectangle.
 *
 * WHY
 * ---
 * The canvas width is what makes the type scale work: at 684 units across a 4.75in column,
 * 1 unit is 0.5pt and Excalidraw's own "S" preset is exactly an 8pt label. But editing moves
 * things, so the extent drifts, and a drifted extent silently rescales every label in the
 * figure. Checking a number by hand after each of 61 edits is exactly the kind of discipline
 * that lapses.
 *
 * A transparent rectangle at (0, 0, 684, H) holds the box open. It renders as nothing --
 * strokeColor and backgroundColor are both 'transparent' -- but Excalidraw's export sizes to
 * the element bounds, so the figure is always exactly 684 wide regardless of what moves.
 *
 * It only sets a FLOOR. Dragging content past x=684 still grows the box, which is correct:
 * that is a real change to how large the figure prints, and finish-diagram.js will say so.
 *
 * The element is named so the next person does not delete it wondering what it is.
 */
const fs = require('fs');
const path = require('path');

const CANVAS_W = 684;
const GUIDE_ID = 'constellize-canvas-guide';
const ROOT = path.resolve(__dirname, '..', '..', 'images', 'diagrams');
const dryRun = process.argv.includes('--dry-run');
const remove = process.argv.includes('--remove');

function listAll(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listAll(p);
    return e.name.endsWith('.excalidraw') ? [p] : [];
  });
}

let done = 0;
for (const file of listAll(ROOT)) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const els = (doc.elements || []).filter((e) => e.id !== GUIDE_ID);

  if (remove) {
    if (els.length !== (doc.elements || []).length) {
      doc.elements = els;
      if (!dryRun) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      console.log(`  removed  ${path.relative(ROOT, file)}`);
      done++;
    }
    continue;
  }

  const live = els.filter((e) => !e.isDeleted && typeof e.x === 'number');
  if (!live.length) continue;
  // Arrows and lines keep their geometry in `points`, offsets from (x, y) that may be
  // negative, so y + height is not the extent. Getting this wrong left the guide taller than
  // the artwork -- knowledge-to-implementation-flow carried 246 units of dead space below
  // its content, which the author saw as a big bottom margin in the render.
  const extY = (e) => (Array.isArray(e.points) && e.points.length
    ? [e.y + Math.min(...e.points.map((p) => p[1])), e.y + Math.max(...e.points.map((p) => p[1]))]
    : [e.y, e.y + (e.height || 0)]);
  const y0 = Math.min(...live.map((e) => extY(e)[0]));
  const y1 = Math.max(...live.map((e) => extY(e)[1]));

  // Behind everything, so a click lands on real content rather than the guide.
  doc.elements = [{
    id: GUIDE_ID,
    type: 'rectangle',
    x: 0, y: y0, width: CANVAS_W, height: y1 - y0,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0,
    opacity: 100, roundness: null, seed: 1, version: 1, versionNonce: 1,
    isDeleted: false, groupIds: [], frameId: null, boundElements: null,
    updated: 1, link: null, locked: true,
    customData: { note: 'Canvas guide: holds the figure at 684 units = 4.75in column. Do not delete.' },
  }, ...els];

  if (!dryRun) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  done++;
}
console.log(`\n  ${done} file(s) ${dryRun ? 'would get' : 'now have'} a ${CANVAS_W}-unit guide` +
            (remove ? ' removed' : ', locked and transparent'));
