#!/usr/bin/env node

/**
 * Prepare diagram artwork for a build target.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 59 diagram PNGs are Excalidraw exports: RGB with an alpha channel, tight bounding
 * boxes, and no consistent padding -- so some sit flush against surrounding text and some
 * do not. Separately, the publisher's print spec (Lightning Source) requires CMYK with no
 * transparency. Both problems are solved by the same pass, because flattening the alpha IS
 * giving them a background, and the same step can add padding and a hairline border.
 *
 * TWO TARGETS, ONE SOURCE
 * -----------------------
 *   print  -> CMYK PDF.  xelatex cannot embed a CMYK PNG, and uncompressed CMYK TIFF runs
 *             ~57MB per diagram; Zip-compressed PDF is ~1.2MB and embeds natively with the
 *             colour space preserved. Callers must rewrite .png references to .pdf.
 *   screen -> RGB PNG, downsized. The EPUB was 54MB, and Amazon charges per-MB delivery.
 *
 * The source PNGs are never modified.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PAD_FRACTION = 0.025;      // of image width, each side
const BORDER_PX = 1;
const BORDER_COLOR = '#c8c8c8';  // light enough not to compete with the artwork
const SCREEN_MAX_WIDTH = 1400;   // ample for any e-reader; the source is up to 7260px

const TOOLS = path.resolve(__dirname, '..');
const SRGB = '/usr/local/texlive/2025/texmf-dist/tex/generic/colorprofiles/sRGB.icc';
const CMYK = path.join(TOOLS, 'color', 'CoatedGRACoL2006.icc');

function sh(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function widthOf(file) {
  return parseInt(sh(['identify', '-format', '%w', file]), 10);
}

/** Flatten alpha onto white, pad by a fraction of width, then hairline border. */
function commonOps(src) {
  const pad = Math.max(8, Math.round(widthOf(src) * PAD_FRACTION));
  return [
    src,
    '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
    '-bordercolor', 'white', '-border', String(pad),
    '-bordercolor', BORDER_COLOR, '-border', String(BORDER_PX),
  ];
}

function buildPrint(src, dst) {
  if (!fs.existsSync(CMYK)) throw new Error(`missing CMYK profile: ${CMYK}`);
  sh([...commonOps(src), '-profile', SRGB, '-profile', CMYK, '-compress', 'Zip', dst]);
}

function buildScreen(src, dst) {
  // Resize FIRST, then pad and border. Bordering before the downscale turns the 1px rule
  // into a sub-pixel smear -- measured #e4e4e4 instead of the #c8c8c8 asked for.
  const tmp = `${dst}.tmp.png`;
  sh([src, '-resize', `${SCREEN_MAX_WIDTH}>`, tmp]);
  const pad = Math.max(8, Math.round(widthOf(tmp) * PAD_FRACTION));
  sh([tmp,
    '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
    '-bordercolor', 'white', '-border', String(pad),
    '-bordercolor', BORDER_COLOR, '-border', String(BORDER_PX),
    '-strip', dst]);
  fs.unlinkSync(tmp);
}

function main() {
  const target = (process.argv[2] || '').replace(/^--target=?/, '') || 'screen';
  const outRoot = process.argv[3];
  if (!['print', 'screen'].includes(target) || !outRoot) {
    console.error('usage: prepare-diagrams.js <print|screen> <outDir>');
    process.exit(2);
  }

  const srcRoot = path.resolve(process.cwd(), 'images', 'diagrams');
  if (!fs.existsSync(srcRoot)) { console.error(`no ${srcRoot}`); process.exit(1); }

  let done = 0, skipped = 0, failed = 0;
  for (const chapter of fs.readdirSync(srcRoot)) {
    const dir = path.join(srcRoot, chapter);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.png')) continue;
      const src = path.join(dir, name);
      const outDir = path.join(outRoot, 'diagrams', chapter);
      fs.mkdirSync(outDir, { recursive: true });
      const dst = path.join(outDir, target === 'print' ? name.replace(/\.png$/, '.pdf') : name);

      // Skip when the output is already newer than its source.
      if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) {
        skipped++; continue;
      }
      try {
        target === 'print' ? buildPrint(src, dst) : buildScreen(src, dst);
        done++;
      } catch (e) {
        failed++;
        console.error(`  FAILED ${chapter}/${name}: ${String(e.message).split('\n')[0]}`);
      }
    }
  }
  console.log(`  diagrams (${target}): ${done} built, ${skipped} cached, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
