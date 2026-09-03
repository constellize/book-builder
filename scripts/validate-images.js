#!/usr/bin/env node

/**
 * Image validation for book content.
 *
 * SEVERITY MODEL
 * --------------
 *   ERROR   -> a referenced image does not exist on disk. The build would emit a
 *              broken figure, so this fails the gate (exit 1).
 *   WARNING -> asset-hygiene findings: orphaned files, stale exports, duplicate
 *              bytes, un-exported sources. These are reported but do NOT fail the
 *              gate, because deciding what to delete or re-export is the author's
 *              call, not this script's. Pass --strict to make them fatal in CI.
 *
 * PREVIOUS COVERAGE HOLE (fixed here)
 * -----------------------------------
 * The on-disk sweep used to be `glob.sync('images/diagrams/ ** /*.png')` only, so
 * it was blind to images/chapters/, images/appendices/, images/named/, and every
 * SVG. It also treated any unreferenced file as a hard failure, which is why
 * widening it naively would have broken the build.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const glob = require('glob');

const STRICT = process.argv.includes('--strict');

// Matches markdown image refs, incl. pandoc-crossref style ![caption](path){#fig:label}
const imageRefRegex = /!\[[^\]]*\]\(([^)]+)\)(?:\{[^}]*\})?/g;

const IMAGE_EXTENSIONS = ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'];

// Directories that hold book imagery.
const IMAGE_GLOBS = IMAGE_EXTENSIONS.map((ext) => `images/**/*.${ext}`);

// ---------------------------------------------------------------------------
// Images that are injected by the builder, not written in markdown.
// ---------------------------------------------------------------------------
// build-book.js emits chapter and appendix opener images itself:
//   build-book.js:349  `\n![](build/assets/images/chapters/ch${chapterNum}.png)\n`
//   build-book.js:365  `\n![](build/assets/images/appendices/app${appendixLetter}.png)\n`
// Those files are therefore in use even though no .md file names them. Each entry
// carries the substring we expect to still find in build-book.js so that if the
// builder stops injecting them, this list is flagged as stale rather than
// silently suppressing a real orphan.
const PROGRAMMATIC_IMAGES = [
  { pattern: /^images\/chapters\/ch\d+\.png$/,   builderMarker: 'images/chapters/ch' },
  { pattern: /^images\/appendices\/app[A-Z]\.png$/, builderMarker: 'images/appendices/app' }
];

const BUILDER_SCRIPT = path.join(__dirname, 'build-book.js');

function isProgrammaticallyUsed(relPath) {
  return PROGRAMMATIC_IMAGES.some((p) => p.pattern.test(relPath));
}

function checkProgrammaticMarkers() {
  let builderSource = '';
  try {
    builderSource = fs.readFileSync(BUILDER_SCRIPT, 'utf8');
  } catch (e) {
    return [`could not read ${BUILDER_SCRIPT} to confirm programmatic image injection: ${e.message}`];
  }
  return PROGRAMMATIC_IMAGES
    .filter((p) => !builderSource.includes(p.builderMarker))
    .map((p) => `build-book.js no longer contains "${p.builderMarker}" - the exemption for ${p.pattern} in validate-images.js may be stale`);
}

// ---------------------------------------------------------------------------
// Markdown file selection
// ---------------------------------------------------------------------------

const bookContentPatterns = [
  /^ch\d+.*\.md$/,           // Chapter files (ch1.md, ch2.md, etc.)
  /^introduction\.md$/,      // Introduction
  /^app[A-Z].*\.md$/,        // Appendix files (appA.md, appB.md, etc.)
  /^foreword.*\.md$/,        // Foreword files
];

const excludePatterns = [
  /^codepromptu\//,
  /^narrative-/,
  /^memory-bank\//,
  /^marketing\//,
  /^tools\//,
  /^build\//,
  /^\.git/,
  /^node_modules\//,
  /^book-builder\//,
  /^book-backup\//,
];

function shouldProcessFile(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);

  if (relativePath.includes('node_modules') ||
      relativePath.includes('book-builder/') ||
      relativePath.includes('book-backup/') ||
      relativePath.includes('.git/')) {
    return false;
  }

  for (const pattern of excludePatterns) {
    if (pattern.test(relativePath)) {
      return false;
    }
  }

  const fileName = path.basename(relativePath);
  return bookContentPatterns.some((pattern) => pattern.test(fileName));
}

function findImageReferences(content) {
  const refs = [];
  let match;
  imageRefRegex.lastIndex = 0;

  while ((match = imageRefRegex.exec(content)) !== null) {
    const imagePath = match[1];
    if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
      refs.push({ path: imagePath, index: match.index });
    }
  }
  return refs;
}

function getLineNumber(text, index) {
  return text.substring(0, index).split('\n').length;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------

function validateImages() {
  console.log('Validating image references and image assets...\n');

  const markdownFiles = glob.sync('**/*.md', {
    ignore: [
      '**/node_modules/**',
      '**/book-builder/**',
      '**/book-backup/**',
      '**/build/**',
      '**/.git/**',
    ]
  });

  const bookFiles = markdownFiles.filter(shouldProcessFile);
  console.log(`Found ${bookFiles.length} book content files to validate.`);

  // ---- collect markdown image references ----
  const allImageRefs = new Map(); // path -> [{ file, line }]

  for (const filePath of bookFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const { path: imagePath, index } of findImageReferences(content)) {
        const line = getLineNumber(content, index);
        if (!allImageRefs.has(imagePath)) allImageRefs.set(imagePath, []);
        allImageRefs.get(imagePath).push({ file: filePath, line });
      }
    } catch (error) {
      console.error(`Error reading ${filePath}: ${error.message}`);
    }
  }

  // ---- sweep every image on disk, all directories, all formats ----
  const imageFiles = [...new Set(IMAGE_GLOBS.flatMap((g) => glob.sync(g)))].sort();
  const byExt = imageFiles.reduce((acc, f) => {
    const e = path.extname(f).slice(1).toLowerCase();
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {});
  console.log(`Found ${imageFiles.length} image files on disk (${Object.entries(byExt).map(([e, n]) => `${n} ${e}`).join(', ')}).\n`);

  const errors = [];
  const warnings = [];

  // === ERROR CHECK: every referenced image exists ===============================
  console.log('--- ERROR CHECK: referenced images exist ---\n');

  const missingImages = [];
  for (const [imagePath, refs] of allImageRefs) {
    if (!fs.existsSync(imagePath)) {
      missingImages.push({ path: imagePath, refs });
      for (const { file, line } of refs) {
        console.log(`MISSING: ${imagePath}`);
        console.log(`  Referenced in ${file}:${line}`);
      }
      errors.push(`missing image: ${imagePath}`);
    }
  }
  console.log(missingImages.length === 0
    ? `OK - all ${allImageRefs.size} referenced images exist.\n`
    : '');

  // === WARNING CHECK 1: orphaned image files ===================================
  console.log('--- WARNING CHECK: orphaned image files ---\n');

  for (const staleNote of checkProgrammaticMarkers()) {
    warnings.push(staleNote);
    console.log(`WARN: ${staleNote}\n`);
  }

  const referencedPaths = new Set(allImageRefs.keys());
  const orphaned = [];
  const svgWithSibling = [];

  for (const imageFile of imageFiles) {
    if (referencedPaths.has(imageFile)) continue;
    if (isProgrammaticallyUsed(imageFile)) continue;

    // An .svg that sits beside a .png of the same name is an intermediate export
    // source (Excalidraw SVG -> convert-to-png.sh -> PNG), not an orphan asset.
    if (imageFile.endsWith('.svg') && fs.existsSync(imageFile.replace(/\.svg$/, '.png'))) {
      svgWithSibling.push(imageFile);
      continue;
    }

    orphaned.push(imageFile);
    warnings.push(`orphaned image: ${imageFile}`);
    console.log(`WARN orphaned: ${imageFile}`);
    console.log(`  Not referenced by any book markdown file and not injected by build-book.js`);
  }
  if (orphaned.length === 0) console.log('OK - no orphaned image files.');
  console.log();

  // === WARNING CHECK 2: stale SVG exports ======================================
  console.log('--- WARNING CHECK: stale export sources ---\n');

  const stale = [];
  for (const svg of svgWithSibling) {
    const png = svg.replace(/\.svg$/, '.png');
    const svgTime = fs.statSync(svg).mtimeMs;
    const pngTime = fs.statSync(png).mtimeMs;
    if (svgTime < pngTime) {
      stale.push({ svg, png });
      warnings.push(`stale export source: ${svg}`);
      console.log(`WARN stale: ${svg}`);
      console.log(`  Older than its exported ${path.basename(png)} - the SVG no longer`);
      console.log(`  reflects the shipped PNG (e.g. a superseded light-theme export).`);
    }
  }
  if (stale.length === 0) console.log('OK - no stale export sources.');
  console.log();

  // === WARNING CHECK 3: byte-identical duplicates ==============================
  console.log('--- WARNING CHECK: byte-identical images ---\n');

  const byHash = new Map();
  for (const f of imageFiles) {
    let h;
    try {
      h = md5(f);
    } catch (e) {
      warnings.push(`unreadable image: ${f} (${e.message})`);
      console.log(`WARN unreadable: ${f} - ${e.message}`);
      continue;
    }
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(f);
  }

  const duplicateGroups = [...byHash.entries()].filter(([, files]) => files.length > 1);
  for (const [hash, files] of duplicateGroups) {
    warnings.push(`duplicate images (md5 ${hash}): ${files.join(', ')}`);
    console.log(`WARN duplicate: ${files.length} files share md5 ${hash}`);
    for (const f of files) console.log(`  - ${f}`);
  }
  if (duplicateGroups.length === 0) console.log('OK - no byte-identical duplicates.');
  console.log();

  // === WARNING CHECK 4: diagram sources with no export =========================
  console.log('--- WARNING CHECK: diagram sources without a PNG export ---\n');

  const sources = glob.sync('images/**/*.excalidraw');
  const unexported = sources.filter((s) => !fs.existsSync(`${s}.png`) && !fs.existsSync(s.replace(/\.excalidraw$/, '.png')));
  for (const s of unexported) {
    warnings.push(`unexported diagram source: ${s}`);
    console.log(`WARN unexported: ${s}`);
  }
  if (unexported.length === 0) console.log('OK - every diagram source has a PNG export.');
  console.log();

  // === Summary =================================================================
  console.log('--- Validation Summary ---\n');
  console.log(`  Book files checked:            ${bookFiles.length}`);
  console.log(`  Image references found:        ${allImageRefs.size}`);
  console.log(`  Image files on disk:           ${imageFiles.length}`);
  console.log(`  Programmatically injected:     ${imageFiles.filter(isProgrammaticallyUsed).length}`);
  console.log('');
  console.log(`  ERRORS   missing images:       ${missingImages.length}`);
  console.log(`  WARNINGS orphaned images:      ${orphaned.length}`);
  console.log(`  WARNINGS stale export sources: ${stale.length}`);
  console.log(`  WARNINGS duplicate groups:     ${duplicateGroups.length}`);
  console.log(`  WARNINGS unexported sources:   ${unexported.length}`);

  if (warnings.length > 0) {
    console.log('\nWarnings (asset hygiene - review, do not auto-delete):');
    for (const w of warnings) console.log(`  - ${w}`);
    console.log('\nNo files are removed by this script. Deleting or re-exporting');
    console.log('assets is an authoring decision. Run with --strict to fail on warnings.');
  }

  if (errors.length > 0 || (STRICT && warnings.length > 0)) {
    console.log('\nIMAGE VALIDATION FAILED\n');
    for (const e of errors) console.log(`  ERROR: ${e}`);
    if (STRICT) for (const w of warnings) console.log(`  STRICT: ${w}`);
    process.exit(1);
  }

  console.log('\nIMAGE VALIDATION PASSED');
  console.log('All referenced images exist. Warnings above are advisory only.');
}

if (require.main === module) {
  validateImages();
}

module.exports = { validateImages };
